import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '@/lib/pipeline/db-adapter';
import { seedFromCsv } from '@/scripts/e2_seed_poster_registry';

const RUN_ID = Date.now();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-seed-'));

describe('seedFromCsv', () => {
  let csvPath: string;
  const testMc = `TESTMC${RUN_ID}`;
  const testName = `Test Seed Shipper ${RUN_ID}`;

  beforeAll(() => {
    csvPath = path.join(tmpDir, 'test-shippers.csv');
    fs.writeFileSync(
      csvPath,
      `legal_name,mc_number,dot_number,country,province_state\n` +
      `"${testName}",${testMc},,CA,ON\n` +
      `"Test Seed Shipper No MC ${RUN_ID}",,,CA,ON\n`,
    );
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await db.query(`DELETE FROM poster_registry WHERE mc_number = $1 OR legal_name LIKE $2`, [testMc, `%${RUN_ID}%`]);
  });

  it('inserts new rows with the given entity_class/class_source/confidence', async () => {
    const result = await seedFromCsv(csvPath, 'shipper', 'seed_shipper_list', 0.9);
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);

    const row = await db.query(`SELECT entity_class, class_source, confidence FROM poster_registry WHERE mc_number = $1`, [testMc]);
    expect(row.rows[0]).toMatchObject({ entity_class: 'shipper', class_source: 'seed_shipper_list', confidence: '0.90' });
  });

  it('is idempotent — re-running does not duplicate or downgrade rows', async () => {
    const result = await seedFromCsv(csvPath, 'shipper', 'seed_shipper_list', 0.9);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(2);

    const rows = await db.query(`SELECT id FROM poster_registry WHERE mc_number = $1`, [testMc]);
    expect(rows.rows.length).toBe(1);
  });

  it('does not downgrade an existing higher-confidence human_review row', async () => {
    await db.query(
      `UPDATE poster_registry SET class_source = 'human_review', confidence = 1.0, entity_class = 'broker' WHERE mc_number = $1`,
      [testMc],
    );
    const result = await seedFromCsv(csvPath, 'shipper', 'seed_shipper_list', 0.9);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const row = await db.query(`SELECT entity_class, confidence FROM poster_registry WHERE mc_number = $1`, [testMc]);
    expect(row.rows[0].entity_class).toBe('broker'); // untouched — human review outranks a re-run seed
  });

  it('returns a warning (not a throw) when the file does not exist', async () => {
    const result = await seedFromCsv(path.join(tmpDir, 'does-not-exist.csv'), 'shipper', 'seed_shipper_list', 0.9);
    expect(result.inserted).toBe(0);
    expect(result.warning).toContain('not found');
  });

  it('parses a fully-quoted row (Excel CSV export shape) without corrupting mc_number with embedded quote characters', async () => {
    // Regression test for final-review finding #5: the old hand-rolled
    // regex parser had no pattern for a row where every field is quoted
    // (`"Name","MC123","","CA","ON"`) — it fell through to the unquoted
    // fallback regex and captured literal `"` characters into mc_number,
    // corrupting poster_registry's unique MC index.
    const quotedMc = `MC${RUN_ID}Q`;
    const quotedName = `Fully Quoted Co ${RUN_ID}`;
    const quotedCsvPath = path.join(tmpDir, 'fully-quoted.csv');
    fs.writeFileSync(
      quotedCsvPath,
      `legal_name,mc_number,dot_number,country,province_state\n` +
      `"${quotedName}","${quotedMc}","","CA","ON"\n`,
    );

    const result = await seedFromCsv(quotedCsvPath, 'shipper', 'seed_shipper_list', 0.9);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);

    const row = await db.query<{ mc_number: string; legal_name: string }>(
      `SELECT mc_number, legal_name FROM poster_registry WHERE mc_number = $1`, [quotedMc],
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].mc_number).toBe(quotedMc);
    expect(row.rows[0].mc_number).not.toMatch(/"/);
    expect(row.rows[0].legal_name).toBe(quotedName);

    await db.query(`DELETE FROM poster_registry WHERE mc_number = $1`, [quotedMc]);
  });
});
