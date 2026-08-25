/**
 * Seeds poster_registry from normalized CSV files. See
 * scripts/data/poster-registry-seed/README.md for the expected format and
 * Engine 2/E2-01_Engine2_Expansion_PRD.md §4.4 for the source list.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/e2_seed_poster_registry.ts
 *   pnpm tsx --env-file=.env.local scripts/e2_seed_poster_registry.ts --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { db } from '@/lib/pipeline/db-adapter';
import { normalizeCompanyName } from '@/lib/pipeline/load-source-classifier';

interface SeedResult {
  inserted: number;
  skipped: number;
  warning?: string;
}

interface CsvRow {
  legal_name: string;
  mc_number: string;
  dot_number: string;
  country: string;
  province_state: string;
}

function parseCsv(text: string): CsvRow[] {
  // papaparse handles fully-quoted rows (a common Excel CSV export shape,
  // e.g. `"Acme","MC123","","CA","ON"`) correctly, unlike the previous
  // hand-rolled regex parser, which fell through to an unquoted-fields
  // pattern for that shape and captured literal quote characters into
  // fields like mc_number, silently corrupting poster_registry's unique
  // MC index. papaparse is already a dependency (see lib/import/csv-parser.ts).
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return result.data.map((row) => ({
    legal_name: row.legal_name ?? '',
    mc_number: row.mc_number ?? '',
    dot_number: row.dot_number ?? '',
    country: row.country ?? '',
    province_state: row.province_state ?? '',
  }));
}

export async function seedFromCsv(
  filePath: string,
  entityClass: 'shipper' | 'broker' | 'carrier_for_hire' | 'carrier_private',
  classSource: string,
  confidence: number,
  dryRun = false,
): Promise<SeedResult> {
  if (!fs.existsSync(filePath)) {
    return { inserted: 0, skipped: 0, warning: `${filePath} not found — skipping this source` };
  }

  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const normalizedName = normalizeCompanyName(row.legal_name);
    const mcNumber = row.mc_number?.trim() || null;
    const dotNumber = row.dot_number?.trim() || null;
    const country = row.country?.trim() || null;

    const existing = await db.query<{ id: number; class_source: string; confidence: string }>(
      `SELECT id, class_source, confidence FROM poster_registry
       WHERE (mc_number IS NOT NULL AND mc_number = $1)
          OR (dot_number IS NOT NULL AND dot_number = $2)
          OR (normalized_name = $3 AND ($4::varchar IS NULL OR country = $4))
       LIMIT 1`,
      [mcNumber, dotNumber, normalizedName, country],
    );

    if (existing.rows.length > 0) {
      // Never downgrade a human-verified or otherwise higher-confidence row with a re-run seed.
      const isHumanVerified = existing.rows[0].class_source === 'human_review';
      const existingConfidence = Number(existing.rows[0].confidence);
      if (isHumanVerified || existingConfidence >= confidence) {
        skipped += 1;
        continue;
      }
      if (!dryRun) {
        await db.query(
          `UPDATE poster_registry SET entity_class = $1, class_source = $2, confidence = $3, updated_at = NOW() WHERE id = $4`,
          [entityClass, classSource, confidence, existing.rows[0].id],
        );
      }
      inserted += 1; // treated as a meaningful write for reporting purposes
      continue;
    }

    if (!dryRun) {
      await db.query(
        `INSERT INTO poster_registry (legal_name, normalized_name, mc_number, dot_number, country, province_state, entity_class, class_source, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [row.legal_name, normalizedName, mcNumber, dotNumber, country, row.province_state || null, entityClass, classSource, confidence],
      );
    }
    inserted += 1;
  }

  return { inserted, skipped };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dataDir = path.join(process.cwd(), 'scripts', 'data', 'poster-registry-seed');

  const sources: Array<[string, 'shipper' | 'broker', string, number]> = [
    [path.join(dataDir, 'pilot1-shippers.csv'), 'shipper', 'seed_shipper_list', 0.9],
    [path.join(dataDir, 'ontario-mines.csv'), 'shipper', 'seed_mines_dossier', 0.95],
    [path.join(dataDir, 'broker-list.csv'), 'broker', 'seed_broker_list', 0.9],
  ];

  let totalInserted = 0;
  for (const [file, entityClass, classSource, confidence] of sources) {
    const result = await seedFromCsv(file, entityClass, classSource, confidence, dryRun);
    if (result.warning) console.log(`⚠ ${result.warning}`);
    else console.log(`${path.basename(file)}: ${result.inserted} inserted/updated, ${result.skipped} skipped (dryRun=${dryRun})`);
    totalInserted += result.inserted;
  }
  console.log(`\nTotal: ${totalInserted} rows inserted/updated across ${sources.length} sources.`);
}

if (require.main === module) {
  main().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
}
