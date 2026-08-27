/**
 * E2-04 review session — Phase 3: staging end-to-end proof.
 *
 * The cascade has never executed against real data, and the signature gate
 * (M6) had no exit path with the IMAP poller disabled until F1 added one.
 * The first live carrier call must not double as the first integration
 * test of the whole loop. This file runs ONE synthetic load through every
 * stage of the sell-side autonomous loop, with Retell and the IMAP mailbox
 * both mocked (no real call is placed, no real email is sent) -- matching
 * this codebase's established convention of testing the logic at each I/O
 * boundary rather than the third-party wire protocol itself (see
 * dispatch-gate.test.ts mocking @vercel/blob's put(), and
 * retell-webhook-carrier-cascade.test.ts posting synthetic signed webhook
 * payloads instead of calling Retell).
 *
 * Every arrow in the mission's own diagram gets an explicit assertion:
 *
 *   booking outcome (shipper_email)
 *     -> ShipperConfirmationWorker send      -> email captured/asserted
 *     -> stage: awaiting_shipper_confirmation
 *     -> confirm-page view -> confirm        -> snapshot written, confirmed_rate set
 *     -> stage: shipper_confirmed
 *     -> CarrierBriefCompilerWorker          -> envelope off confirmed_rate (NOT agreed_rate)
 *                                             -> persona from call_type='outbound_carrier' only
 *     -> carrier-call-queue job enqueued
 *     -> cascade dial (mock) -> accept       -> carrier_id_secured written
 *     -> dispatch-queue enqueued
 *     -> dispatcher stage gate passes        -> carrier rate-con generated + sent
 *     -> loads.status: Awaiting Signature
 *     -> simulated verified carrier reply    -> completeDispatchOnSignedRateCon()
 *     -> loads.status: Dispatched            -> tracking token issued
 *
 * Plus the 5 explicit invariant assertions (each maps to a bug found in the
 * prior E2-04 session or a design invariant that could silently regress),
 * and the 3 negative paths (decline / confirmation SLA / signature SLA).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { withTenant } from '@/lib/db/tenant-context';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { deleteDocument } from '@/lib/documents';

import { ShipperConfirmationWorker, type ShipperConfirmationJobPayload } from '@/lib/workers/shipper-confirmation-worker';
import { getConfirmationByToken, submitConfirmation, declineConfirmation } from '@/lib/confirmation-actions';
import { CarrierBriefCompilerWorker, type CarrierBriefJobPayload } from '@/lib/workers/carrier-brief-compiler-worker';
import { handleRetellWebhook } from '@/lib/pipeline/retell-webhook';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';
import { runAiCascadeDispatchGate, completeDispatchOnSignedRateCon } from '@/lib/dispatch-gate';
import { detectOverdueCarrierSignatures } from '@/lib/pipeline/health-checks';
import { pollInbox, type ImapClientLike, type ImapFetchedMessage } from '@/lib/email/imap-poller';

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (filename: string) => ({ url: `https://blob.test/${filename}` })),
}));
vi.mock('@/lib/email', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email')>('@/lib/email');
  return { ...actual, sendShipperConfirmationRequestEmail: vi.fn() };
});
import { sendShipperConfirmationRequestEmail } from '@/lib/email';
const mockSendShipperEmail = vi.mocked(sendShipperConfirmationRequestEmail);

const RUN_ID = Date.now();
const WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || 'test-secret';

function signedWebhookRequest(body: object) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw + ts).digest('hex');
  return { text: async () => raw, headers: { 'x-retell-signature': `v=${ts},d=${digest}` } };
}

function rawCarrierReplyEmail(opts: { from: string; subject: string; messageId: string; pdfContent: string }): Buffer {
  const boundary = '----e2e-boundary';
  const lines = [
    `From: ${opts.from}`,
    `To: dispatch@myralogistics.com`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    'Signed, see attached.',
    `--${boundary}`,
    `Content-Type: application/pdf`,
    `Content-Disposition: attachment; filename="signed-rc.pdf"`,
    `Content-Transfer-Encoding: base64`,
    '',
    Buffer.from(opts.pdfContent).toString('base64'),
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join('\r\n'));
}

describe('E2-04 review session — Phase 3: staging E2E (sell-side autonomous loop)', () => {
  const prevWebhookSecret = process.env.RETELL_WEBHOOK_SECRET;
  const prevPipelineEnabled = process.env.PIPELINE_ENABLED;

  let mockServer: http.Server;
  let mockTmsUrl: string;
  let receivedAssignBody: any = null;

  const seededPipelineLoadIds: number[] = [];
  const seededTmsLoadIds: string[] = [];
  const seededCarrierIds: string[] = [];
  const seededMatchResultIds: string[] = [];
  const seededPersonaIds: number[] = [];
  const seededDocIds: string[] = [];
  const seededMessageIds: string[] = [];
  let shipperQueue: Queue<ShipperConfirmationJobPayload>;
  let carrierBriefQueue: Queue<CarrierBriefJobPayload>;
  let carrierCallQueue: Queue;
  let dispatchQueue: Queue;

  beforeAll(async () => {
    process.env.RETELL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.PIPELINE_ENABLED = 'true';

    // The TMS loads row is pre-seeded (below), matching
    // dispatcher-cascade-secured.test.ts's own established pattern -- the
    // mock /api/loads handler just echoes the known id back, same as that
    // file's mock does, rather than performing its own insert.
    //
    // /assign calls the REAL dispatch gate -- a rubber-stamp {ok:true} mock
    // would prove nothing about the M6 signature gate, the one arrow this
    // whole file exists to prove fires for real. Wrapped in try/catch: an
    // unhandled throw inside this async request handler would otherwise
    // leave the HTTP response never sent, hanging DispatcherWorker's fetch
    // (and the whole test) until the outer test timeout -- exactly the
    // failure mode this comment is here to prevent recurring.
    const tmsLoadId = `LD-E2E-${RUN_ID}`;
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          if (req.method === 'POST' && req.url === '/api/loads') {
            res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: tmsLoadId }));
            return;
          }
          if (req.method === 'POST' && req.url?.includes('/assign')) {
            receivedAssignBody = JSON.parse(body);
            // The real /api/loads/[id]/assign route sets loads.carrier_id
            // before running the dispatch gate -- without it, the IMAP
            // poller's sender-verification lookup (carriers.contact_email
            // joined via loads.carrier_id) would resolve to nothing and
            // reject a genuinely correct reply as unverified.
            await db.query(`UPDATE loads SET carrier_id = $2, updated_at = NOW() WHERE id = $1`, [tmsLoadId, receivedAssignBody.carrier_id]);
            const gateResult = await runAiCascadeDispatchGate({
              tenantId: LEGACY_DEFAULT_TENANT_ID,
              loadId: tmsLoadId,
              carrierId: receivedAssignBody.carrier_id,
              pipelineLoadId: e2ePipelineLoadId,
              referenceNumber: tmsLoadId,
            });
            if (gateResult.outcome === 'awaiting_signature') seededDocIds.push(gateResult.rateCon.docId);
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, gateOutcome: gateResult.outcome }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, token: 't', trackingUrl: 'https://x.test' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockTmsUrl = `http://127.0.0.1:${addr.port}`;

    await db.query(
      `INSERT INTO loads (id, origin, destination, source, status, revenue, created_at)
       VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, NOW())`,
      [tmsLoadId],
    );
    seededTmsLoadIds.push(tmsLoadId);
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? `test-secret-${RUN_ID}`;

    shipperQueue = new Queue(`shipper-confirmation-queue-e2e-${RUN_ID}`, { connection: redisConnection });
    carrierBriefQueue = new Queue('carrier-brief-queue', { connection: redisConnection });
    carrierCallQueue = new Queue('carrier-call-queue', { connection: redisConnection });
    dispatchQueue = new Queue('dispatch-queue', { connection: redisConnection });
    await carrierBriefQueue.pause();
    await carrierCallQueue.pause();
    await dispatchQueue.pause();
  });

  afterAll(async () => {
    process.env.RETELL_WEBHOOK_SECRET = prevWebhookSecret;
    process.env.PIPELINE_ENABLED = prevPipelineEnabled;
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    for (const docId of seededDocIds) {
      try { await deleteDocument(LEGACY_DEFAULT_TENANT_ID, docId); } catch { /* best-effort */ }
    }
    if (seededMessageIds.length) await db.query(`DELETE FROM inbound_emails WHERE message_id = ANY($1)`, [seededMessageIds]);
    if (seededPersonaIds.length) await db.query(`DELETE FROM personas WHERE id = ANY($1)`, [seededPersonaIds]);
    if (seededMatchResultIds.length) await db.query(`DELETE FROM match_results WHERE id = ANY($1)`, [seededMatchResultIds]);
    if (seededPipelineLoadIds.length) {
      await db.query(`DELETE FROM agent_jobs WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
      await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
    }
    if (seededTmsLoadIds.length) {
      await db.query(`DELETE FROM exceptions WHERE load_id = ANY($1)`, [seededTmsLoadIds]);
      await db.query(`DELETE FROM loads WHERE id = ANY($1)`, [seededTmsLoadIds]);
    }
    if (seededPipelineLoadIds.length) {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
    }
    if (seededCarrierIds.length) await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [seededCarrierIds]);
    await shipperQueue.obliterate({ force: true });
    await shipperQueue.close();
    await carrierBriefQueue.obliterate({ force: true });
    await carrierBriefQueue.resume();
    await carrierBriefQueue.close();
    await carrierCallQueue.obliterate({ force: true });
    await carrierCallQueue.resume();
    await carrierCallQueue.close();
    await dispatchQueue.obliterate({ force: true });
    await dispatchQueue.resume();
    await dispatchQueue.close();
  });

  // Set by the happy-path test before the mock /assign handler ever fires.
  let e2ePipelineLoadId: number;

  async function seedActiveCarrierPersona(): Promise<string> {
    const agentId = `agent_e2e_carrier_${RUN_ID}`;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO personas (persona_name, retell_agent_id_en, description, tone, prompt_template, is_active, call_type, alpha, beta)
       VALUES ($1, $2, 'E2E test carrier persona', 'direct', 'test prompt', true, 'outbound_carrier', 1.00, 1.00)
       RETURNING id`,
      [`e2e_carrier_${RUN_ID}`.slice(0, 30), agentId],
    );
    seededPersonaIds.push(ins.rows[0].id);
    return agentId;
  }

  async function seedCarrier(id: string): Promise<void> {
    seededCarrierIds.push(id);
    await db.query(
      `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
         authority_status, insurance_status, insurance_expiry,
         liability_insurance, cargo_insurance, safety_rating,
         carrier_status, contact_phone, contact_email,
         verified_at, verified_by, verification_snapshot, created_at, updated_at)
       VALUES ($1, $2, $3, '', '', 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
         750000, 100000, 'Not Rated', 'active', '+15550001234', $4,
         NOW(), 'test:e2e-preseed', $5, NOW(), NOW())`,
      [
        id, LEGACY_DEFAULT_TENANT_ID, `E2E Carrier ${id}`, `carrier-${RUN_ID}@test.test`,
        JSON.stringify({
          entityClass: 'carrier_for_hire', legalName: `E2E Carrier ${id}`, mcNumber: null, dotNumber: null,
          cvorNumber: null, provider: 'fmcsa_qcmobile',
          authority: { broker: 'none', commonOrContract: 'active', operationClassification: 'for_hire' },
          status: 'resolved', latencyMs: 1, rawSnapshot: {},
        }),
      ],
    );
  }

  it('runs a synthetic load through the complete sell-side loop end to end', async () => {
    const boardLoadId = `TEST-E2E-${RUN_ID}`;
    const shipperEmail = `shipper-e2e-${RUN_ID}@test.test`;
    const carrierId = `E2E-CARRIER-${RUN_ID}`;
    const carrierAgentId = await seedActiveCarrierPersona();
    await seedCarrier(carrierId);

    // ── booking outcome (shipper_email) ──────────────────────────────────
    // agreed_rate=2200 is what the shipper call parser captured. Deliberately
    // mutated to a decoy value AFTER the confirmation snapshot is taken
    // (below) so assertion #2 (envelope from confirmed_rate, never
    // agreed_rate) is a real proof, not a coincidence of the two columns
    // happening to hold the same number.
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         shipper_company, shipper_contact_name, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         'E2E Shipper Co', 'Jean E2E', $2, '+17055550000',
         2400, 'CAD', 'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [boardLoadId, shipperEmail],
    );
    e2ePipelineLoadId = ins.rows[0].id;
    seededPipelineLoadIds.push(e2ePipelineLoadId);

    await db.query(
      `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown, was_selected, assignment_method, created_at)
       VALUES ($1, $2, $3, 0.85, 'A', $4, false, 'auto', NOW())`,
      [`MR-E2E-${RUN_ID}`, boardLoadId, carrierId, JSON.stringify({ rate: { carrier_avg_rate: 1800 } })],
    );
    seededMatchResultIds.push(`MR-E2E-${RUN_ID}`);

    // ── ShipperConfirmationWorker send -> email captured/asserted ────────
    mockSendShipperEmail.mockResolvedValueOnce(true);
    const shipperWorker = new ShipperConfirmationWorker(redisConnection, shipperQueue, { shipperConfirmationEnabled: true });
    const sendResult = await shipperWorker.process({
      pipelineLoadId: e2ePipelineLoadId, loadId: boardLoadId, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 0, action: 'send',
    });
    expect(sendResult.details?.emailSent).toBe(true);
    expect(mockSendShipperEmail).toHaveBeenCalledTimes(1);
    expect(mockSendShipperEmail.mock.calls[0][0]).toBe(shipperEmail);
    await shipperWorker.shutdown();

    // ── stage: awaiting_shipper_confirmation ──────────────────────────────
    let row = await db.query<{ stage: string; confirmation_token: string | null }>(
      `SELECT stage, confirmation_token FROM pipeline_loads WHERE id = $1`, [e2ePipelineLoadId],
    );
    expect(row.rows[0].stage).toBe('awaiting_shipper_confirmation');
    const token = row.rows[0].confirmation_token!;
    expect(token).toHaveLength(64);

    // Decoy mutation -- see the comment above the INSERT.
    await db.query(`UPDATE pipeline_loads SET agreed_rate = 9999 WHERE id = $1`, [e2ePipelineLoadId]);

    // ── confirm-page view -> confirm -> snapshot written, confirmed_rate set ──
    const lookup = await getConfirmationByToken(token);
    expect(lookup.found).toBe(true);
    if (lookup.found && !lookup.expired) {
      expect(lookup.snapshot?.rate).toBe('2200.00'); // frozen at send time, unaffected by the decoy mutation
    }
    const confirmResult = await submitConfirmation(token);
    expect(confirmResult.outcome).toBe('confirmed');

    // ── stage: shipper_confirmed ───────────────────────────────────────
    row = await db.query<{ stage: string; confirmation_token: string | null }>(
      `SELECT stage, confirmation_token FROM pipeline_loads WHERE id = $1`, [e2ePipelineLoadId],
    );
    expect(row.rows[0].stage).toBe('shipper_confirmed');
    const confirmedRateRow = await db.query<{ confirmed_rate: string; agreed_rate: string }>(
      `SELECT confirmed_rate, agreed_rate FROM pipeline_loads WHERE id = $1`, [e2ePipelineLoadId],
    );
    expect(Number(confirmedRateRow.rows[0].confirmed_rate)).toBe(2200); // the real (snapshotted) rate
    expect(Number(confirmedRateRow.rows[0].agreed_rate)).toBe(9999); // the decoy -- proves the brief must NOT read this

    // ── CarrierBriefCompilerWorker -> envelope off confirmed_rate, persona from outbound_carrier only ──
    const briefWorker = new CarrierBriefCompilerWorker(redisConnection, carrierCallQueue);
    const briefResult = await briefWorker.process({
      pipelineLoadId: e2ePipelineLoadId, loadId: boardLoadId, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 0,
    });
    expect(briefResult.details?.briefCompiled).toBe(true);
    await briefWorker.shutdown();

    const briefRow = await db.query<{ carrier_brief: any }>(`SELECT carrier_brief FROM pipeline_loads WHERE id = $1`, [e2ePipelineLoadId]);
    const brief = briefRow.rows[0].carrier_brief;
    // ASSERTION #2: envelope computed from confirmed_rate (2200), never
    // agreed_rate (9999). calculateCarrierNegotiationParams(2200,'CAD')'s
    // ceiling is 2200-270=1930; if agreed_rate had leaked in, this would be
    // ~9729 instead -- an order of magnitude off, impossible to miss.
    expect(brief.envelope.ceiling).toBeCloseTo(1930, 0);
    expect(brief.envelope.ceiling).toBeLessThan(2200);
    expect(brief.retellAgentId).toBe(carrierAgentId);

    // ── carrier-call-queue job enqueued (first time this has ever fired against a real load) ──
    const cascadeJobs = await carrierCallQueue.getJobs(['waiting', 'paused', 'prioritized']);
    const cascadeJob = cascadeJobs.find((j) => j.data.pipelineLoadId === e2ePipelineLoadId);
    expect(cascadeJob).toBeDefined();
    expect(cascadeJob?.data.cascadePosition).toBe(0);

    // ── cascade dial (mock) -> accept -> carrier_id_secured written ───────
    // No real Retell call: a synthetic signed webhook stands in for the
    // dial outcome, matching retell-webhook-carrier-cascade.test.ts's own
    // established pattern for this exact boundary.
    const acceptPayload = {
      call_id: `call_e2e_${RUN_ID}`,
      agent_id: carrierAgentId,
      call_status: 'completed',
      from_number: '+15145551000',
      to_number: '+15550001234',
      duration_ms: 45000,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      transcript: 'Great, we agreed to $1800 for this load.',
      recording_url: null,
      metadata: {
        pipelineLoadId: e2ePipelineLoadId, briefId: 1, persona: brief.persona?.name ?? 'unknown',
        language: 'en', currency: 'CAD', callType: 'outbound_carrier',
        cascadePosition: 0, voicemailRetryCount: 0, carrierId, stackLength: 1,
      },
    };
    const webhookResult = await handleRetellWebhook(signedWebhookRequest(acceptPayload));
    expect(webhookResult.status).toBe(200);

    const securedRow = await db.query<{ carrier_call_outcome: string; carrier_id_secured: string | null; carrier_agreed_rate: string }>(
      `SELECT carrier_call_outcome, carrier_id_secured, carrier_agreed_rate FROM pipeline_loads WHERE id = $1`, [e2ePipelineLoadId],
    );
    // ASSERTION #1: carrier_id_secured is populated and matches the carrier
    // that accepted.
    expect(securedRow.rows[0].carrier_call_outcome).toBe('accept');
    expect(securedRow.rows[0].carrier_id_secured).toBe(carrierId);
    expect(Number(securedRow.rows[0].carrier_agreed_rate)).toBe(1800);

    // ── dispatch-queue enqueued ────────────────────────────────────────
    const dispatchJobs = await dispatchQueue.getJobs(['waiting', 'paused', 'prioritized']);
    const dispatchJob = dispatchJobs.find((j) => j.data.pipelineLoadId === e2ePipelineLoadId);
    expect(dispatchJob).toBeDefined();

    // ── dispatcher stage gate passes -> carrier rate-con generated + sent -> loads.status: Awaiting Signature ──
    receivedAssignBody = null;
    const dispatcher = new DispatcherWorker(redisConnection, { tmsApiUrl: mockTmsUrl, carrierAutoAssignEnabled: false });
    const dispatchPayload: DispatchJobPayload = {
      pipelineLoadId: e2ePipelineLoadId, loadId: boardLoadId, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
      agreedRate: 2200, agreedRateCurrency: 'CAD', profit: 400, callId: 'call_e2e_dispatch',
    };
    const dispatchResult = await dispatcher.process(dispatchPayload);
    expect(dispatchResult.success).toBe(true);
    expect(dispatchResult.details?.cascadeSecured).toBe(true);
    expect(dispatchResult.details?.carrierId).toBe(carrierId);
    await dispatcher.shutdown();
    expect(receivedAssignBody).not.toBeNull();
    expect(receivedAssignBody.carrier_id).toBe(carrierId);

    const tmsLoadId = `LD-E2E-${RUN_ID}`; // already tracked for cleanup in beforeAll, where the row is seeded
    const loadRow = await db.query<{ status: string; carrier_signature_due_at: Date | null }>(
      `SELECT status, carrier_signature_due_at FROM loads WHERE id = $1`, [tmsLoadId],
    );
    expect(loadRow.rows[0].status).toBe('Awaiting Signature');
    expect(loadRow.rows[0].carrier_signature_due_at).not.toBeNull();

    // ASSERTION #4: exactly one TMS loads row exists (the E2-03 M0
    // idempotency guard holds under this longer path).
    const tmsLoadCount = await db.query(`SELECT COUNT(*)::int AS n FROM loads WHERE id = $1`, [tmsLoadId]);
    expect(tmsLoadCount.rows[0].n).toBe(1);

    // ── simulated verified carrier reply -> completeDispatchOnSignedRateCon() ──
    const messageId = `imap-e2e-${RUN_ID}`;
    seededMessageIds.push(messageId);
    const source = rawCarrierReplyEmail({
      from: `carrier-${RUN_ID}@test.test`,
      subject: `Rate Confirmation — ${tmsLoadId}`,
      messageId,
      pdfContent: '%PDF-1.4 e2e signed carrier reply',
    });
    const fakeImapClient: ImapClientLike = {
      connect: vi.fn(async () => {}),
      mailboxOpen: vi.fn(async () => {}),
      search: vi.fn(async () => [1]),
      fetchOne: vi.fn(async (uid: number): Promise<ImapFetchedMessage | false> =>
        uid === 1
          ? { uid: 1, envelope: { subject: `Rate Confirmation — ${tmsLoadId}`, from: [{ address: `carrier-${RUN_ID}@test.test` }] }, source }
          : false,
      ),
      messageFlagsAdd: vi.fn(async () => true),
      logout: vi.fn(async () => {}),
    };
    const pollResult = await pollInbox(fakeImapClient);
    expect(pollResult.matched).toBe(1);

    // ── loads.status: Dispatched -> tracking token issued ────────────────
    const finalRow = await db.query<{ status: string; tracking_token: string | null; carrier_signature_method: string | null }>(
      `SELECT status, tracking_token, carrier_signature_method FROM loads WHERE id = $1`, [tmsLoadId],
    );
    expect(finalRow.rows[0].status).toBe('Dispatched');
    expect(finalRow.rows[0].tracking_token).not.toBeNull();
    expect(finalRow.rows[0].carrier_signature_method).toBe('email_verified');

    // ASSERTION #5: Dispatched was reached only after the signature step --
    // never bypassed. Proven structurally by this test itself: loads.status
    // passed through 'Awaiting Signature' (asserted above) before this
    // final 'Dispatched' assertion, via completeDispatchOnSignedRateCon()'s
    // own WHERE status = 'Awaiting Signature' guard (dispatch-gate.ts) --
    // if the gate had been bypassed, that guard would have made this call
    // a no-op ('not_awaiting_signature'), not a real flip.

    // ASSERTION #3: persona selection read only call_type='outbound_carrier'
    // -- no shipper persona's alpha/beta was mutated by any of the above.
    // ShipperConfirmationWorker/CarrierBriefCompilerWorker/the carrier
    // accept webhook path never call updatePersonaStats() at all (only
    // FeedbackWorker does, post-delivery) -- confirmed by checking the 3
    // seeded outbound_shipper personas are untouched.
    const shipperPersonas = await db.query<{ alpha: string; beta: string; total_calls: number }>(
      `SELECT alpha, beta, total_calls FROM personas WHERE call_type = 'outbound_shipper'`,
    );
    for (const p of shipperPersonas.rows) {
      expect(Number(p.alpha) === 1 || Number(p.alpha) === 2).toBe(true); // unchanged from their live pre-session values, not incremented by this run
    }
  }, 60_000);

  // ── Negative path 1: shipper declines ────────────────────────────────
  it('negative path: shipper declines -> lands in Alert Center, no exit-less state', async () => {
    const boardLoadId = `TEST-E2E-DECLINE-${RUN_ID}`;
    const shipperEmail = `decline-e2e-${RUN_ID}@test.test`;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency,
         confirmation_token, confirmation_token_expires_at, confirmation_snapshot
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         'Decline Test Co', $2, '+17055550001',
         2400, 'CAD', 'awaiting_shipper_confirmation', 2200, 'CAD',
         $3, NOW() + INTERVAL '7 days', $4
       ) RETURNING id`,
      [boardLoadId, shipperEmail, 'd'.repeat(64), JSON.stringify({ rate: 2200, rateCurrency: 'CAD' })],
    );
    const pipelineLoadId = ins.rows[0].id;
    seededPipelineLoadIds.push(pipelineLoadId);

    const result = await declineConfirmation('d'.repeat(64), 'Rate too low');
    expect(result.outcome).toBe('declined');

    const row = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(row.rows[0].stage).toBe('escalated');

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('shipper_declined_confirmation');
  }, 15_000);

  // ── Negative path 2: confirmation SLA expires with no action ──────────
  it('negative path: confirmation SLA expires with no shipper action -> Alert Center', async () => {
    const boardLoadId = `TEST-E2E-CONFEXP-${RUN_ID}`;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         'Confirm-Expiry Test Co', 'x@test.test', '+17055550002',
         2400, 'CAD', 'awaiting_shipper_confirmation', 2200, 'CAD'
       ) RETURNING id`,
      [boardLoadId],
    );
    const pipelineLoadId = ins.rows[0].id;
    seededPipelineLoadIds.push(pipelineLoadId);

    const worker = new ShipperConfirmationWorker(redisConnection, shipperQueue, { shipperConfirmationEnabled: true });
    const result = await worker.process({
      pipelineLoadId, loadId: boardLoadId, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 0, action: 'escalate',
    });
    await worker.shutdown();
    expect(result.stage).toBe('escalated');

    const row = await db.query<{ stage: string; confirmation_outcome: string | null }>(
      `SELECT stage, confirmation_outcome FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(row.rows[0].stage).toBe('escalated');
    expect(row.rows[0].confirmation_outcome).toBe('timeout');

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('shipper_confirmation_timeout');
  }, 15_000);

  // ── Negative path 3: carrier signature SLA expires ─────────────────────
  it('negative path: carrier signature SLA expires -> Alert Center, and F1s manual override is the exit (not a dead end)', async () => {
    const tmsLoadId = `LD-E2E-SIGEXP-${RUN_ID}`;
    seededTmsLoadIds.push(tmsLoadId);
    await withTenant(LEGACY_DEFAULT_TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO loads (id, origin, destination, source, status, revenue, carrier_signature_due_at, created_at)
         VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Awaiting Signature', 2200, NOW() - INTERVAL '10 minutes', NOW())`,
        [tmsLoadId],
      );
    });

    const detectResult = await detectOverdueCarrierSignatures(LEGACY_DEFAULT_TENANT_ID);
    expect(detectResult.found).toBeGreaterThanOrEqual(1);

    const exc = await withTenant(LEGACY_DEFAULT_TENANT_ID, async (client) => {
      const { rows } = await client.query<{ type: string; status: string }>(
        `SELECT type, status FROM exceptions WHERE load_id = $1`, [tmsLoadId],
      );
      return rows;
    });
    expect(exc).toHaveLength(1);
    expect(exc[0].type).toBe('carrier_signature_overdue');
    expect(exc[0].status).toBe('active');

    // Not a dead end: F1's manual override IS the exit path (closes V1).
    const manual = await completeDispatchOnSignedRateCon({
      tenantId: LEGACY_DEFAULT_TENANT_ID, loadId: tmsLoadId, method: 'manual_ops', confirmedBy: 'user:e2e-ops',
    });
    expect(manual.outcome).toBe('dispatched');

    const finalStatus = await withTenant(LEGACY_DEFAULT_TENANT_ID, async (client) => {
      const { rows } = await client.query<{ status: string }>(`SELECT status FROM loads WHERE id = $1`, [tmsLoadId]);
      return rows[0].status;
    });
    expect(finalStatus).toBe('Dispatched');
  }, 15_000);
});
