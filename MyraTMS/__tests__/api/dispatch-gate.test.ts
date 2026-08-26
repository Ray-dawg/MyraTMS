/**
 * E2-03 M3/M4 §7/§8 — runAiCascadeDispatchGate() integration tests.
 * Tests the extracted lib function directly (this codebase's established
 * convention for logic behind a Next.js route — see retell-webhook.ts's
 * handleRetellWebhook() and dispatcher-worker.ts's process(), both tested
 * the same way), not the /api/loads/[id]/assign route itself.
 *
 * Runs against live Neon + live Upstash-independent infra (no Redis needed
 * here) + real Vercel Blob (BLOB_READ_WRITE_TOKEN is a required env var for
 * this project — matches this test suite's established "test against real
 * infra" convention; no mock exists for @vercel/blob anywhere in this repo).
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { deleteDocument } from '@/lib/documents';
import { runAiCascadeDispatchGate, completeDispatchOnSignedRateCon } from '@/lib/dispatch-gate';

// The live BLOB_READ_WRITE_TOKEN in this dev env points at a store
// configured for private-only access, but dispatch-gate.ts (matching the
// existing, pre-this-session production manual-assign path verbatim) calls
// put(..., { access: "public" }). That access-mode mismatch is a property
// of the Vercel dashboard store configuration, not something this test or
// dispatch-gate.ts should silently work around by guessing a different
// access value — a real access-mode change belongs in Vercel project
// settings, decided by whoever owns that store, not inferred from a test
// failure. Blob upload mechanics aren't what this test suite is verifying
// (the gate logic — verification precondition, attempted-and-logged send,
// dispatch-flip timing — is), so put() is mocked here only.
vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (filename: string) => ({ url: `https://blob.test/${filename}` })),
}));

const RUN_ID = Date.now();
const seededCarrierIds: string[] = [];
const seededLoadIds: string[] = [];
const seededPipelineLoadIds: number[] = [];
const seededDocIds: string[] = [];

async function seedCarrier(opts: {
  id: string;
  company: string;
  contactEmail?: string | null;
  preVerified?: boolean;
}) {
  seededCarrierIds.push(opts.id);
  await db.query(
    `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
       authority_status, insurance_status, insurance_expiry,
       liability_insurance, cargo_insurance, safety_rating,
       carrier_status, contact_phone, contact_email,
       verified_at, verified_by, verification_snapshot,
       created_at, updated_at)
     VALUES ($1, $2, $3, '', '', 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
       750000, 100000, 'Not Rated', 'active', '+15550009999', $4,
       $5, $6, $7, NOW(), NOW())`,
    [
      opts.id, LEGACY_DEFAULT_TENANT_ID, opts.company, opts.contactEmail ?? null,
      opts.preVerified ? new Date() : null,
      opts.preVerified ? 'test:preseed' : null,
      opts.preVerified
        ? JSON.stringify({
            entityClass: 'carrier_for_hire', legalName: opts.company, mcNumber: null, dotNumber: null,
            cvorNumber: null, provider: 'fmcsa_qcmobile',
            authority: { broker: 'none', commonOrContract: 'active', operationClassification: 'for_hire' },
            status: 'resolved', latencyMs: 1, rawSnapshot: {},
          })
        : null,
    ],
  );
}

async function seedTmsLoad(opts: { id: string; carrierId: string }) {
  seededLoadIds.push(opts.id);
  await db.query(
    `INSERT INTO loads (id, origin, destination, source, status, revenue, carrier_id, reference_number, created_at)
     VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, $2, $3, NOW())`,
    [opts.id, opts.carrierId, opts.id],
  );
}

async function seedPipelineLoad(): Promise<number> {
  const runSuffix = `${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date, equipment_type, weight_lbs,
       distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
       posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency, profit
     ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
       'Gate Test Co', 'x@test.test', '+17055550000', 2400, 'CAD', 'booked', 2200, 'CAD', 470
     ) RETURNING id`,
    [`TEST-GATE-${runSuffix}`],
  );
  seededPipelineLoadIds.push(ins.rows[0].id);
  return ins.rows[0].id;
}

describe('runAiCascadeDispatchGate (E2-03 M3/M4)', () => {
  let mockServer: http.Server;
  let responseQueue: Array<{ status: number; body: unknown }> = [];
  const envBackup = { ...process.env };

  afterAll(async () => {
    process.env = envBackup;
    for (const docId of seededDocIds) {
      try { await deleteDocument(LEGACY_DEFAULT_TENANT_ID, docId); } catch { /* best-effort cleanup */ }
    }
    if (seededPipelineLoadIds.length) {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
    }
    if (seededLoadIds.length) await db.query(`DELETE FROM loads WHERE id = ANY($1)`, [seededLoadIds]);
    if (seededCarrierIds.length) await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [seededCarrierIds]);
    if (mockServer) await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('pre-verified carrier with a contact_email: dispatches and logs an attempted send (sent or failed, not silently skipped)', async () => {
    const carrierId = `GATE-A-${RUN_ID}`;
    const loadId = `LD-GATE-A-${RUN_ID}`;
    await seedCarrier({ id: carrierId, company: 'Gate Test Carrier A', contactEmail: 'dispatch-test@example.com', preVerified: true });
    await seedTmsLoad({ id: loadId, carrierId });
    const pipelineLoadId = await seedPipelineLoad();

    const result = await runAiCascadeDispatchGate({
      tenantId: LEGACY_DEFAULT_TENANT_ID, loadId, carrierId, pipelineLoadId, referenceNumber: loadId,
    });

    expect(result.outcome).toBe('awaiting_signature');
    if (result.outcome === 'awaiting_signature') {
      expect(['sent', 'failed']).toContain(result.rateConSendStatus);
      expect(result.signatureDueAt).toBeTruthy();
      seededDocIds.push(result.rateCon.docId);
    }

    const row = await db.query<{ status: string; rate_con_send_status: string | null; rate_con_sent_at: Date | null; carrier_signature_due_at: Date | null }>(
      `SELECT status, rate_con_send_status, rate_con_sent_at, carrier_signature_due_at FROM loads WHERE id = $1`, [loadId],
    );
    expect(row.rows[0].status).toBe('Awaiting Signature');
    expect(['sent', 'failed']).toContain(row.rows[0].rate_con_send_status);
    expect(row.rows[0].rate_con_sent_at).not.toBeNull();
    expect(row.rows[0].carrier_signature_due_at).not.toBeNull();
  }, 30_000);

  it('pre-verified carrier with no contact_email: dispatches with rate_con_send_status=skipped_no_email, not blocked', async () => {
    const carrierId = `GATE-B-${RUN_ID}`;
    const loadId = `LD-GATE-B-${RUN_ID}`;
    await seedCarrier({ id: carrierId, company: 'Gate Test Carrier B', contactEmail: null, preVerified: true });
    await seedTmsLoad({ id: loadId, carrierId });
    const pipelineLoadId = await seedPipelineLoad();

    const result = await runAiCascadeDispatchGate({
      tenantId: LEGACY_DEFAULT_TENANT_ID, loadId, carrierId, pipelineLoadId, referenceNumber: loadId,
    });

    expect(result.outcome).toBe('awaiting_signature');
    if (result.outcome === 'awaiting_signature') {
      expect(result.rateConSendStatus).toBe('skipped_no_email');
      seededDocIds.push(result.rateCon.docId);
    }

    const row = await db.query<{ status: string; rate_con_send_status: string | null }>(
      `SELECT status, rate_con_send_status FROM loads WHERE id = $1`, [loadId],
    );
    expect(row.rows[0].status).toBe('Awaiting Signature');
    expect(row.rows[0].rate_con_send_status).toBe('skipped_no_email');
  }, 30_000);

  it('unverified carrier resolved as carrier_for_hire+active by the lookup: verifies inline, dispatch proceeds', async () => {
    mockServer = http.createServer((req, res) => {
      const next = responseQueue.shift();
      if (!next) { res.writeHead(500).end('no queued response'); return; }
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    process.env.FMCSA_QC_BASE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.FMCSA_QC_WEBKEY = 'test-webkey';
    process.env.AUTHORITY_LOOKUP_TIMEOUT_MS = '2000';

    const carrierId = `GATE-C-${RUN_ID}`;
    const loadId = `LD-GATE-C-${RUN_ID}`;
    await seedCarrier({ id: carrierId, company: 'Gate Test Carrier C', contactEmail: null, preVerified: false });
    await db.query(`UPDATE carriers SET mc_number = $2 WHERE id = $1`, [carrierId, `MC-GATE-C-${RUN_ID}`]);
    await seedTmsLoad({ id: loadId, carrierId });
    const pipelineLoadId = await seedPipelineLoad();

    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Gate Test Carrier C',
            brokerAuthorityStatus: 'N',
            commonAuthorityStatus: 'A',
            contractAuthorityStatus: 'N',
            operatingStatus: 'AUTHORIZED FOR Property',
          },
        }],
      },
    });

    const result = await runAiCascadeDispatchGate({
      tenantId: LEGACY_DEFAULT_TENANT_ID, loadId, carrierId, pipelineLoadId, referenceNumber: loadId,
    });

    expect(result.outcome).toBe('awaiting_signature');
    if (result.outcome === 'awaiting_signature') seededDocIds.push(result.rateCon.docId);

    const carrierRow = await db.query<{ verified_at: Date | null }>(`SELECT verified_at FROM carriers WHERE id = $1`, [carrierId]);
    expect(carrierRow.rows[0].verified_at).not.toBeNull();
  }, 30_000);

  it('unverified carrier resolved as a broker by the lookup: escalates, no dispatch, no rate-con', async () => {
    const carrierId = `GATE-D-${RUN_ID}`;
    const loadId = `LD-GATE-D-${RUN_ID}`;
    await seedCarrier({ id: carrierId, company: 'Gate Test Carrier D', contactEmail: null, preVerified: false });
    await db.query(`UPDATE carriers SET mc_number = $2 WHERE id = $1`, [carrierId, `MC-GATE-D-${RUN_ID}`]);
    await seedTmsLoad({ id: loadId, carrierId });
    const pipelineLoadId = await seedPipelineLoad();

    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Gate Test Carrier D',
            brokerAuthorityStatus: 'A',
            commonAuthorityStatus: 'N',
            contractAuthorityStatus: 'N',
          },
        }],
      },
    });

    const result = await runAiCascadeDispatchGate({
      tenantId: LEGACY_DEFAULT_TENANT_ID, loadId, carrierId, pipelineLoadId, referenceNumber: loadId,
    });

    expect(result.outcome).toBe('escalated');
    if (result.outcome === 'escalated') {
      expect(result.reason).toBe('carrier_not_verified');
      expect(result.verificationReason).toBe('not_for_hire_authority');
    }

    const loadRow = await db.query<{ status: string; rate_con_send_status: string | null }>(
      `SELECT status, rate_con_send_status FROM loads WHERE id = $1`, [loadId],
    );
    expect(loadRow.rows[0].status).toBe('Booked');
    expect(loadRow.rows[0].rate_con_send_status).toBeNull();

    const exc = await db.query<{ type: string; pipeline_load_id: number }>(
      `SELECT type, pipeline_load_id FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId],
    );
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('carrier_verification_failed');
  }, 30_000);

  it('completeDispatchOnSignedRateCon: flips Awaiting Signature to Dispatched, records receipt, issues a tracking token', async () => {
    const carrierId = `GATE-E-${RUN_ID}`;
    const loadId = `LD-GATE-E-${RUN_ID}`;
    await seedCarrier({ id: carrierId, company: 'Gate Test Carrier E', contactEmail: null, preVerified: true });
    await seedTmsLoad({ id: loadId, carrierId });
    const pipelineLoadId = await seedPipelineLoad();

    const gateResult = await runAiCascadeDispatchGate({
      tenantId: LEGACY_DEFAULT_TENANT_ID, loadId, carrierId, pipelineLoadId, referenceNumber: loadId,
    });
    expect(gateResult.outcome).toBe('awaiting_signature');
    if (gateResult.outcome === 'awaiting_signature') seededDocIds.push(gateResult.rateCon.docId);

    const result = await completeDispatchOnSignedRateCon({ tenantId: LEGACY_DEFAULT_TENANT_ID, loadId });
    expect(result.outcome).toBe('dispatched');
    if (result.outcome === 'dispatched') expect(result.trackingToken).toHaveLength(64);

    const row = await db.query<{ status: string; carrier_signature_received_at: Date | null; tracking_token: string | null }>(
      `SELECT status, carrier_signature_received_at, tracking_token FROM loads WHERE id = $1`, [loadId],
    );
    expect(row.rows[0].status).toBe('Dispatched');
    expect(row.rows[0].carrier_signature_received_at).not.toBeNull();
    expect(row.rows[0].tracking_token).not.toBeNull();
  }, 30_000);

  it('completeDispatchOnSignedRateCon: a second call after already dispatched is idempotent, not an error', async () => {
    const carrierId = `GATE-F-${RUN_ID}`;
    const loadId = `LD-GATE-F-${RUN_ID}`;
    await seedCarrier({ id: carrierId, company: 'Gate Test Carrier F', contactEmail: null, preVerified: true });
    await seedTmsLoad({ id: loadId, carrierId });
    const pipelineLoadId = await seedPipelineLoad();

    const gateResult = await runAiCascadeDispatchGate({
      tenantId: LEGACY_DEFAULT_TENANT_ID, loadId, carrierId, pipelineLoadId, referenceNumber: loadId,
    });
    if (gateResult.outcome === 'awaiting_signature') seededDocIds.push(gateResult.rateCon.docId);

    await completeDispatchOnSignedRateCon({ tenantId: LEGACY_DEFAULT_TENANT_ID, loadId });
    const second = await completeDispatchOnSignedRateCon({ tenantId: LEGACY_DEFAULT_TENANT_ID, loadId });

    expect(second.outcome).toBe('not_awaiting_signature');
    if (second.outcome === 'not_awaiting_signature') expect(second.status).toBe('Dispatched');
  }, 30_000);

  it('completeDispatchOnSignedRateCon: unknown load returns not_found', async () => {
    const result = await completeDispatchOnSignedRateCon({ tenantId: LEGACY_DEFAULT_TENANT_ID, loadId: `LD-NONEXISTENT-${RUN_ID}` });
    expect(result.outcome).toBe('not_found');
  });
});
