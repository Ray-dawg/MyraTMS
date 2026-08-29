// scripts/t25_reconcile_payer_registry.ts
//
// T-25 §4.1/§4.3 — resolves the spec's broken payer_registry join by
// populating pipeline_loads.payer_registry_id. No MC-number equivalent
// exists for payers, so matching is by normalized (trimmed, lowercased)
// shipper_company text against payer_registry.legal_name — confirmed
// workable against real data (256 pipeline_loads rows, only 15 distinct
// normalized company names). Idempotent: only processes rows where
// payer_registry_id IS NULL.

import { db } from '../lib/pipeline/db-adapter';

interface PipelineLoadRow {
  id: number;
  shipper_company: string;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export async function reconcilePayerRegistry(): Promise<{ total: number; matched: number; created: number }> {
  const { rows } = await db.query<PipelineLoadRow>(
    `SELECT id, shipper_company FROM pipeline_loads
      WHERE shipper_company IS NOT NULL AND payer_registry_id IS NULL`,
  );

  let matched = 0;
  let created = 0;
  const cache = new Map<string, number>();

  for (const row of rows) {
    const key = normalize(row.shipper_company);
    let payerId = cache.get(key);

    if (payerId === undefined) {
      const existing = await db.query<{ id: number }>(
        `SELECT id FROM payer_registry WHERE LOWER(TRIM(legal_name)) = $1 LIMIT 1`,
        [key],
      );
      if (existing.rows.length > 0) {
        payerId = existing.rows[0].id;
        matched++;
      } else {
        const inserted = await db.query<{ id: number }>(
          `INSERT INTO payer_registry (legal_name) VALUES ($1) RETURNING id`,
          [row.shipper_company.trim()],
        );
        payerId = inserted.rows[0].id;
        created++;
      }
      cache.set(key, payerId);
    } else {
      matched++;
    }

    await db.query(`UPDATE pipeline_loads SET payer_registry_id = $1 WHERE id = $2`, [payerId, row.id]);
  }

  return { total: rows.length, matched, created };
}

async function main(): Promise<void> {
  const result = await reconcilePayerRegistry();
  console.log(`Reconciled ${result.total} pipeline_loads rows: ${result.matched} matched an existing payer, ${result.created} created a new payer_registry row.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[t25-reconcile-payer] failed:', err);
    process.exit(1);
  });
}
