import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { backfillBatch } from '@/scripts/e2_backfill_load_source';

const RUN_ID = Date.now();
const TEST_LOAD_ID_1 = `TESTBF1-${RUN_ID}`;
const TEST_LOAD_ID_2 = `TESTBF2-${RUN_ID}`;
const TEST_MC = `TESTMC${RUN_ID}`;

describe('backfillBatch (shadow mode)', () => {
  let pipelineLoadId1: number;
  let pipelineLoadId2: number;
  let registryId: number;
  let mockServer: http.Server;
  const envBackup = { ...process.env };

  beforeAll(async () => {
    // pipelineLoadId2 has no registry hit, so backfillBatch will call
    // lookupAuthority() for it. Point FMCSA_QC_BASE_URL at a local mock that
    // always returns an empty result set (not_found) — deterministic, no
    // real webKey needed (matches the "build now, test later" decision in
    // the Session 1 design doc), no real network access from a test.
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [] }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    process.env.FMCSA_QC_BASE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.FMCSA_QC_WEBKEY = 'test-webkey';
    process.env.AUTHORITY_LOOKUP_TIMEOUT_MS = '2000';

    const reg = await db.query<{ id: number }>(
      `INSERT INTO poster_registry (legal_name, normalized_name, mc_number, entity_class, class_source, confidence)
       VALUES ('Test Backfill Shipper', 'test backfill shipper', $1, 'shipper', 'human_review', 1.0) RETURNING id`,
      [TEST_MC],
    );
    registryId = reg.rows[0].id;

    const insertLoad = async (loadId: string, mcNumber: string | null, companyRaw: string) => {
      const r = await db.query<{ id: number }>(
        `INSERT INTO pipeline_loads (
           load_id, load_board_source, origin_city, origin_state, origin_country,
           destination_city, destination_state, destination_country,
           pickup_date, delivery_date, equipment_type, weight_lbs,
           distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
           posted_rate, posted_rate_currency, stage,
           poster_company_raw, poster_company_normalized, poster_mc_number
         ) VALUES (
           $1, 'DAT', 'Toronto', 'ON', 'CA', 'Montreal', 'QC', 'CA',
           NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
           330, 540, $2, 'test@example.test', '+15555550100',
           2400, 'CAD', 'qualified', $2, $3, $4
         ) RETURNING id`,
        [loadId, companyRaw, companyRaw.toLowerCase(), mcNumber],
      );
      return r.rows[0].id;
    };

    pipelineLoadId1 = await insertLoad(TEST_LOAD_ID_1, TEST_MC, 'Test Backfill Shipper');
    pipelineLoadId2 = await insertLoad(TEST_LOAD_ID_2, null, 'Some Unregistered Freight Co');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    process.env = envBackup;
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [[pipelineLoadId1, pipelineLoadId2]]);
    await db.query(`DELETE FROM poster_registry WHERE id = $1`, [registryId]);
    await db.query(`DELETE FROM authority_lookups WHERE lookup_key LIKE $1`, [`%unregistered%`]);
  });

  it('classifies a registry-hit load and writes the classification block WITHOUT touching stage or qualification_reason', async () => {
    const summary = await backfillBatch([pipelineLoadId1]);
    expect(summary.processed).toBe(1);
    expect(summary.byVerdict.accept).toBe(1);

    const row = await db.query(
      `SELECT stage, qualification_reason, load_source_class, load_source_method, load_source_confidence, load_source_evaluated_at, poster_registry_id
       FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId1],
    );
    expect(row.rows[0].stage).toBe('qualified'); // unchanged — shadow mode never touches stage
    expect(row.rows[0].qualification_reason).toBeNull(); // unchanged
    expect(row.rows[0].load_source_class).toBe('shipper_direct');
    expect(row.rows[0].load_source_method).toBe('registry');
    expect(row.rows[0].poster_registry_id).toBe(registryId);
    expect(row.rows[0].load_source_evaluated_at).not.toBeNull();
  });

  it('is idempotent — re-running without --force skips already-classified rows', async () => {
    const summary = await backfillBatch([pipelineLoadId1]);
    expect(summary.processed).toBe(0);
    expect(summary.skippedAlreadyClassified).toBe(1);
  });

  it('--force re-classifies an already-classified row', async () => {
    const summary = await backfillBatch([pipelineLoadId1], { force: true });
    expect(summary.processed).toBe(1);
  });

  it('a load with no registry hit and (stubbed) failed lookup routes to review, never a silent accept', async () => {
    const summary = await backfillBatch([pipelineLoadId2]);
    expect(summary.processed).toBe(1);

    const row = await db.query(
      `SELECT load_source_class, qualification_detail FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId2],
    );
    expect(row.rows[0].load_source_class).not.toBe('shipper_direct');
    expect(row.rows[0].load_source_class).not.toBe('co_brokered');
  });
}, 30_000);
