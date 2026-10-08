/**
 * E2-01 §4.7 step 3 — resolve a load-source review.
 *
 * A human answers "is this poster a shipper, a broker, or a carrier?" once.
 * The answer is written to poster_registry (confidence 1.0, human_review),
 * the load goes back to 'scanned', its Alert Center row is resolved, and the
 * load is re-enqueued to qualify-queue. The Qualifier then resolves it
 * deterministically from the registry — the human informs the filter chain,
 * never bypasses it.
 *
 * Not transactional: lib/pipeline/db-adapter.ts rides the Neon HTTP driver,
 * where every statement autocommits. The writes are ordered so a partial
 * failure is safe and re-runnable: registry first (idempotent upsert), then
 * the load reset, then the exception resolve, then the enqueue.
 */
import type { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

export type ResolveEntityClass = 'shipper' | 'broker' | 'carrier_for_hire' | 'carrier_private';

export interface ResolveSourceInput {
  pipelineLoadId: number;
  entityClass: ResolveEntityClass;
  /** true → upsert poster_registry so every future load from this poster resolves without a human. */
  appliesToPoster: boolean;
  note: string | null;
  /** user id from the JWT */
  resolvedBy: string;
}

export type ResolveSourceResult =
  | { ok: true; registryId: number | null; reEnqueued: true }
  | { ok: false; error: 'not_found' | 'not_in_review' | 'expired' | 'no_poster_identity' };

interface LoadRow {
  id: number;
  load_id: string;
  load_board_source: string;
  stage: string;
  qualification_reason: string | null;
  origin_city: string;
  origin_state: string;
  origin_country: string;
  destination_city: string;
  destination_state: string;
  destination_country: string;
  equipment_type: string;
  posted_rate: string | null;
  posted_rate_currency: string | null;
  distance_miles: string | null;
  pickup_date: Date | string;
  shipper_phone: string | null;
  poster_company_raw: string | null;
  poster_company_normalized: string | null;
  poster_mc_number: string | null;
  poster_dot_number: string | null;
  shipper_direct_attestation: 'yes' | 'no' | 'unknown' | null;
  created_by: string | null;
}

const PICKUP_FRESHNESS_MS = 4 * 3600_000; // mirrors the Qualifier's F2 window

export async function resolveLoadSource(input: ResolveSourceInput, qualifyQueue: Queue): Promise<ResolveSourceResult> {
  const load = (await db.query<LoadRow>(`SELECT * FROM pipeline_loads WHERE id = $1`, [input.pipelineLoadId])).rows[0];
  if (!load) return { ok: false, error: 'not_found' };
  if (load.stage !== 'escalated' || !(load.qualification_reason ?? '').endsWith('_review')) {
    return { ok: false, error: 'not_in_review' };
  }
  if (new Date(load.pickup_date).getTime() < Date.now() + PICKUP_FRESHNESS_MS) {
    return { ok: false, error: 'expired' };
  }
  if (input.appliesToPoster && !load.poster_mc_number && !load.poster_company_normalized) {
    return { ok: false, error: 'no_poster_identity' };
  }

  let registryId: number | null = null;
  if (input.appliesToPoster) {
    registryId = load.poster_mc_number ? await upsertByMc(load, input) : await upsertByName(load, input);
  }

  await db.query(
    `UPDATE pipeline_loads
       SET stage = 'scanned', stage_updated_at = NOW(),
           qualification_reason = NULL, qualification_detail = NULL,
           poster_registry_id = COALESCE($2, poster_registry_id),
           updated_at = NOW()
     WHERE id = $1`,
    [load.id, registryId],
  );
  await db.query(
    `UPDATE exceptions SET status = 'resolved', resolved_at = NOW()
      WHERE pipeline_load_id = $1 AND type = 'load_source_review' AND status <> 'resolved'`,
    [load.id],
  );

  await qualifyQueue.add('qualify', {
    pipelineLoadId: load.id,
    loadId: load.load_id,
    loadBoardSource: load.load_board_source,
    enqueuedAt: new Date().toISOString(),
    priority: 0,
    origin: { city: load.origin_city, state: load.origin_state, country: load.origin_country },
    destination: { city: load.destination_city, state: load.destination_state, country: load.destination_country },
    equipmentType: load.equipment_type,
    postedRate: load.posted_rate ? Number(load.posted_rate) : null,
    postedRateCurrency: load.posted_rate_currency ?? 'USD',
    distanceMiles: load.distance_miles ? Number(load.distance_miles) : 0,
    pickupDate: new Date(load.pickup_date).toISOString(),
    shipperPhone: load.shipper_phone,
    posterCompanyRaw: load.poster_company_raw,
    posterMcNumber: load.poster_mc_number,
    posterDotNumber: load.poster_dot_number,
    isManualImport: (load.created_by ?? '').startsWith('scanner-csv'),
    attestation: load.shipper_direct_attestation,
  });

  logger.info(`[resolve-source] load ${load.id} resolved as ${input.entityClass} by ${input.resolvedBy}; re-enqueued`);
  return { ok: true, registryId, reEnqueued: true };
}

async function upsertByMc(load: LoadRow, input: ResolveSourceInput): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO poster_registry
       (legal_name, normalized_name, mc_number, dot_number, country, entity_class, class_source, confidence, verified_by, last_verified_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, 'human_review', 1.0, $7, NOW(), $8)
     ON CONFLICT (mc_number) WHERE mc_number IS NOT NULL DO UPDATE
       SET entity_class = EXCLUDED.entity_class, class_source = 'human_review', confidence = 1.0,
           verified_by = EXCLUDED.verified_by, last_verified_at = NOW(), notes = EXCLUDED.notes, updated_at = NOW()
     RETURNING id`,
    [
      load.poster_company_raw,
      load.poster_company_normalized ?? '',
      load.poster_mc_number,
      load.poster_dot_number,
      load.origin_country,
      input.entityClass,
      input.resolvedBy,
      input.note,
    ],
  );
  return r.rows[0].id;
}

async function upsertByName(load: LoadRow, input: ResolveSourceInput): Promise<number> {
  const existing = await db.query<{ id: number }>(
    `SELECT id FROM poster_registry
      WHERE normalized_name = $1 AND country IS NOT DISTINCT FROM $2::varchar AND mc_number IS NULL
      LIMIT 1`,
    [load.poster_company_normalized, load.origin_country],
  );
  if (existing.rows[0]) {
    await db.query(
      `UPDATE poster_registry
         SET entity_class = $2, class_source = 'human_review', confidence = 1.0,
             verified_by = $3, last_verified_at = NOW(), notes = $4, updated_at = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, input.entityClass, input.resolvedBy, input.note],
    );
    return existing.rows[0].id;
  }
  const r = await db.query<{ id: number }>(
    `INSERT INTO poster_registry
       (legal_name, normalized_name, dot_number, country, entity_class, class_source, confidence, verified_by, last_verified_at, notes)
     VALUES ($1, $2, $3, $4, $5, 'human_review', 1.0, $6, NOW(), $7)
     RETURNING id`,
    [load.poster_company_raw, load.poster_company_normalized, load.poster_dot_number, load.origin_country, input.entityClass, input.resolvedBy, input.note],
  );
  return r.rows[0].id;
}
