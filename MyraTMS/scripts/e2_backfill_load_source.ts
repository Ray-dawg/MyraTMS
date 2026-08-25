/**
 * Shadow-mode historical backfill for the shipper-direct classifier. Writes
 * pipeline_loads.load_source_* columns for existing rows; never touches
 * stage or qualification_reason (that's Session 2's Qualifier wiring).
 * Idempotent and resumable — safe to interrupt and re-run.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/e2_backfill_load_source.ts
 *   pnpm tsx --env-file=.env.local scripts/e2_backfill_load_source.ts --force --batch-size=50
 *
 * See Engine 2/E2-01_Engine2_Expansion_PRD.md §4.12 step 3.
 */

import { db } from '@/lib/pipeline/db-adapter';
import { lookupAuthority } from '@/lib/verification/authority-lookup';
import {
  classifyLoadSource,
  findRegistryHit,
  findActiveAgreement,
  normalizeCompanyName,
  type ClassifyLoadSourceInput,
} from '@/lib/pipeline/load-source-classifier';

export interface BackfillSummary {
  processed: number;
  skippedAlreadyClassified: number;
  byVerdict: { accept: number; reject: number; review: number };
}

interface PipelineLoadRow {
  id: number;
  poster_company_raw: string | null;
  poster_company_normalized: string | null;
  poster_mc_number: string | null;
  poster_dot_number: string | null;
  origin_country: string | null;
  created_by: string | null;
  shipper_direct_attestation: 'yes' | 'no' | 'unknown' | null;
  shipper_company: string | null;
}

export async function backfillBatch(
  loadIds: number[],
  opts: { force?: boolean } = {},
): Promise<BackfillSummary> {
  const summary: BackfillSummary = { processed: 0, skippedAlreadyClassified: 0, byVerdict: { accept: 0, reject: 0, review: 0 } };

  const rows = await db.query<PipelineLoadRow>(
    `SELECT id, poster_company_raw, poster_company_normalized, poster_mc_number, poster_dot_number,
            origin_country, created_by, shipper_direct_attestation, shipper_company
     FROM pipeline_loads
     WHERE id = ANY($1) AND ($2::boolean OR load_source_evaluated_at IS NULL)`,
    [loadIds, Boolean(opts.force)],
  );

  const classifiedIds = new Set(rows.rows.map((r) => r.id));
  summary.skippedAlreadyClassified = loadIds.filter((id) => !classifiedIds.has(id)).length;

  for (const row of rows.rows) {
    const isManualImport = row.created_by === 'scanner-csv-v1' || row.created_by === 'scanner-csv-v2';

    // No ingest path populates poster_company_raw/poster_company_normalized
    // yet (added by this session's migration 040) — fall back to the
    // historical shipper_company column (populated by scanner-worker.ts) so
    // the backfill can actually classify real historical data instead of
    // routing every row to poster_identity_missing.
    const companyRaw = row.poster_company_raw ?? row.shipper_company;
    const companyNormalized = row.poster_company_normalized ?? (companyRaw ? normalizeCompanyName(companyRaw) : null);

    const registryHit = await findRegistryHit(
      row.poster_mc_number, row.poster_dot_number, companyNormalized, row.origin_country,
    );

    let lookupResult = null;
    let agreementMatch = null;
    if (!registryHit && !isManualImport && (row.poster_mc_number || row.poster_dot_number || companyNormalized)) {
      lookupResult = await lookupAuthority({
        mcNumber: row.poster_mc_number ?? undefined,
        dotNumber: row.poster_dot_number ?? undefined,
        companyName: companyRaw ?? undefined,
        country: (row.origin_country as 'CA' | 'US') ?? 'CA',
      });
      if (lookupResult.status === 'resolved' && lookupResult.authority.broker === 'active') {
        agreementMatch = await findActiveAgreement(row.poster_mc_number, companyNormalized);
      }
    }
    if (registryHit?.entityClass === 'broker') {
      agreementMatch = await findActiveAgreement(row.poster_mc_number, companyNormalized);
    }

    const input: ClassifyLoadSourceInput = {
      poster: {
        companyRaw,
        companyNormalized,
        mcNumber: row.poster_mc_number,
        dotNumber: row.poster_dot_number,
      },
      isManualImport,
      attestation: isManualImport && row.shipper_direct_attestation ? { value: row.shipper_direct_attestation } : null,
      registryHit,
      lookupResult,
      agreementMatch,
    };

    const result = classifyLoadSource(input);

    // qualification_reason/qualification_detail is Session 2's live-path
    // contract (short code / prose sentence pair per PRD §4.9). The backfill
    // is shadow-mode and must not write either column — instead the short
    // reason code rides along inside load_source_evidence for audit.
    const evidence = { ...result.evidence, reasonCode: result.reasonCode };

    await db.query(
      `UPDATE pipeline_loads
       SET load_source_class = $1, load_source_method = $2, load_source_confidence = $3,
           load_source_evaluated_at = NOW(), load_source_evidence = $4,
           poster_registry_id = $5
       WHERE id = $6`,
      [
        result.class, result.method, result.confidence, JSON.stringify(evidence),
        registryHit?.id ?? null, row.id,
      ],
    );

    summary.processed += 1;
    summary.byVerdict[result.verdict] += 1;
  }

  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
  const batchSize = batchSizeArg ? Number(batchSizeArg.split('=')[1]) : 100;

  let offset = 0;
  const totals: BackfillSummary = { processed: 0, skippedAlreadyClassified: 0, byVerdict: { accept: 0, reject: 0, review: 0 } };

  while (true) {
    // Non-force mode's WHERE clause (load_source_evaluated_at IS NULL) is
    // self-shrinking: every batch classifies rows and removes them from the
    // set future queries match. So "the next unprocessed batch" is always at
    // OFFSET 0 — advancing offset there would skip rows that fell out of the
    // matching set. --force mode's WHERE clause matches every row every
    // time regardless of prior classification, so OFFSET must advance there
    // or the loop reprocesses the same first batch forever.
    const queryOffset = force ? offset : 0;
    const idRows = await db.query<{ id: number }>(
      `SELECT id FROM pipeline_loads WHERE ($1::boolean OR load_source_evaluated_at IS NULL) ORDER BY id LIMIT $2 OFFSET $3`,
      [force, batchSize, queryOffset],
    );
    if (idRows.rows.length === 0) break;

    const summary = await backfillBatch(idRows.rows.map((r) => r.id), { force });
    totals.processed += summary.processed;
    totals.skippedAlreadyClassified += summary.skippedAlreadyClassified;
    totals.byVerdict.accept += summary.byVerdict.accept;
    totals.byVerdict.reject += summary.byVerdict.reject;
    totals.byVerdict.review += summary.byVerdict.review;

    console.log(`Processed ${totals.processed} rows so far (batch offset ${queryOffset})...`);
    offset += batchSize;
  }

  console.log(`\nDone. processed=${totals.processed} accept=${totals.byVerdict.accept} reject=${totals.byVerdict.reject} review=${totals.byVerdict.review}`);
}

if (require.main === module) {
  main().catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
}
