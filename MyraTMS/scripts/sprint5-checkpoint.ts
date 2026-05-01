/**
 * Sprint 5 CHECKPOINT — full pipeline operational, end-to-end.
 *
 * Drives every worker manually for a single load:
 *   Scanner → Qualifier → Researcher + Ranker (parallel, gate)
 *           → Compiler → Voice (skipped, shadow)
 *           → manual stage flip to 'booked' (simulating webhook outcome)
 *           → Dispatcher (mocked TMS routes) → Feedback
 *
 * Asserts:
 *   - Brief compiled, dispatcher hits all 4 TMS routes
 *   - pipeline_loads.tms_load_id is populated
 *   - Persona α/β increments by 1 for the chosen persona
 *   - shipper_preferences upserts with the agreed rate
 *   - Final stage = 'scored' (after Feedback)
 *   - 0 real Retell hits (kill switch)
 *
 * Run: pnpm tsx --env-file=.env.local scripts/sprint5-checkpoint.ts
 */

import http from 'http';
import { Queue } from 'bullmq';
import { db } from '../lib/pipeline/db-adapter';
import { redisConnection } from '../lib/pipeline/redis-bullmq';
import { ScannerService } from '../lib/workers/scanner-worker';
import { QualifierWorker } from '../lib/workers/qualifier-worker';
import { ResearcherWorker } from '../lib/workers/researcher-worker';
import { RankerWorker } from '../lib/workers/ranker-worker';
import { CompilerWorker } from '../lib/workers/compiler-worker';
import { VoiceWorker } from '../lib/workers/voice-worker';
import { DispatcherWorker } from '../lib/workers/dispatcher-worker';
import { FeedbackWorker } from '../lib/workers/feedback-worker';

const REAL_CARRIER_ID = 'car_001';
const RUN = `SPRINT5-${Date.now()}`;
const FAKE_TMS_LOAD_ID = `LD-S5-${Date.now().toString(36).toUpperCase()}`;

async function main() {
  // --- Pin clock to 2pm ---
  const noon = new Date();
  noon.setHours(14, 0, 0, 0);
  const fixedTime = noon.getTime();
  const RealDate = Date;
  // @ts-expect-error monkey-patch
  global.Date = class extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixedTime);
      // @ts-expect-error spread
      else super(...args);
    }
    static now() { return fixedTime; }
    static parse = RealDate.parse;
    static UTC = RealDate.UTC;
  };

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sprint5-checkpoint-secret';

  // --- Mock 2 servers: Retell (must be 0 hits) + TMS (Dispatcher's target) ---
  let retellHits = 0;
  const retellMock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      retellHits++;
      console.error('!!! RETELL WAS HIT — kill switch failed');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ call_id: `should_not_happen_${Date.now()}` }));
    });
  });
  await new Promise<void>((resolve) => retellMock.listen(0, '127.0.0.1', resolve));
  const retellAddr = retellMock.address();
  if (!retellAddr || typeof retellAddr === 'string') throw new Error('retell mock failed');
  const retellUrl = `http://127.0.0.1:${retellAddr.port}`;

  let tmsHits: string[] = [];
  const tmsMock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      tmsHits.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/api/loads') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: FAKE_TMS_LOAD_ID }));
      } else if (req.url?.endsWith('/assign') || req.url?.endsWith('/tracking-token') || req.url?.endsWith('/send-tracking')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: 'mock' }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => tmsMock.listen(0, '127.0.0.1', resolve));
  const tmsAddr = tmsMock.address();
  if (!tmsAddr || typeof tmsAddr === 'string') throw new Error('tms mock failed');
  const tmsUrl = `http://127.0.0.1:${tmsAddr.port}`;

  process.env.PIPELINE_ENABLED = 'true';
  process.env.MAX_CONCURRENT_CALLS = '0'; // shadow mode

  const qualifyQ = new Queue(`qualify-q-${RUN}`, { connection: redisConnection });
  const researchQ = new Queue(`research-q-${RUN}`, { connection: redisConnection });
  const matchQ = new Queue(`match-q-${RUN}`, { connection: redisConnection });
  const briefQ = new Queue(`brief-q-${RUN}`, { connection: redisConnection });
  const callQ = new Queue(`call-q-${RUN}`, { connection: redisConnection });
  const dispatchQ = new Queue(`dispatch-q-${RUN}`, { connection: redisConnection });
  const feedbackQ = new Queue(`feedback-q-${RUN}`, { connection: redisConnection });

  const scanner = new ScannerService(redisConnection, qualifyQ);
  const qualifier = new QualifierWorker(redisConnection, researchQ, matchQ);
  const researcher = new ResearcherWorker(redisConnection, briefQ);
  const ranker = new RankerWorker(redisConnection, briefQ);
  const compiler = new CompilerWorker(redisConnection, callQ);
  const voice = new VoiceWorker(redisConnection, { retellApiKey: 'test', retellBaseUrl: retellUrl });
  const dispatcher = new DispatcherWorker(redisConnection, { tmsApiUrl: tmsUrl });
  const feedback = new FeedbackWorker(redisConnection);

  let pipelineLoadId = 0;
  let briefId: number | null = null;
  let alphaBefore = 0;
  let betaBefore = 0;
  let chosenPersona: string | null = null;
  const startedAt = Date.now();

  try {
    // ─── Step 1: Scanner CSV ingest ─────────────────────────────────────
    console.log('\n[1] Scanner: CSV ingest');
    const ingest = await scanner.ingestRawLoads(
      [{
        loadId: `${RUN}-A`,
        loadBoardSource: 'manual',
        originCity: 'Toronto',
        originState: 'ON',
        originCountry: 'CA',
        destinationCity: 'Sudbury',
        destinationState: 'ON',
        destinationCountry: 'CA',
        equipmentType: 'Dry Van',
        pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
        postedRate: 2400,
        postedRateCurrency: 'CAD',
        distanceMiles: 250,
        shipperCompany: 'Northern Mine Supply Co',
        shipperEmail: 'jm@nmsco.test',
        shipperPhone: '+17055551861',
      }],
      'manual',
    );
    pipelineLoadId = ingest.insertedIds[0];
    console.log(`    pipeline_load id=${pipelineLoadId}`);

    // ─── Step 2: Qualifier ──────────────────────────────────────────────
    console.log('[2] Qualifier');
    const qJob = (await qualifyQ.getJobs(['waiting', 'prioritized', 'active']))
      .find((j) => j.data.pipelineLoadId === pipelineLoadId);
    const qResult = await qualifier.process(qJob!.data);
    await (qualifier as any).updatePipelineLoad(pipelineLoadId, qResult);

    // ─── Step 3+4: Researcher + Ranker in parallel ──────────────────────
    console.log('[3+4] Researcher + Ranker (parallel)');
    const rJob = (await researchQ.getJobs(['waiting', 'prioritized', 'active']))
      .find((j) => j.data.pipelineLoadId === pipelineLoadId);
    const mJob = (await matchQ.getJobs(['waiting', 'prioritized', 'active']))
      .find((j) => j.data.pipelineLoadId === pipelineLoadId);
    const [rResult, mResult] = await Promise.all([
      researcher.process(rJob!.data),
      ranker.process(mJob!.data),
    ]);
    await (researcher as any).updatePipelineLoad(pipelineLoadId, rResult);
    await (ranker as any).updatePipelineLoad(pipelineLoadId, mResult);

    if (!mResult.details?.matched) {
      console.log('    No carriers matched — skipping rest of pipeline');
      return;
    }

    // ─── Step 5: Compiler ───────────────────────────────────────────────
    console.log('[5] Compiler');
    const bJob = (await briefQ.getJobs(['waiting', 'prioritized', 'active']))
      .find((j) => j.data.pipelineLoadId === pipelineLoadId);
    const cResult = await compiler.process(bJob!.data);
    await (compiler as any).updatePipelineLoad(pipelineLoadId, cResult);
    briefId = cResult.details?.briefId;
    chosenPersona = (cResult.details as any)?.persona;
    console.log(`    briefId=${briefId}, persona=${chosenPersona}`);

    // Snapshot persona α/β BEFORE feedback fires
    const preP = await db.query<{ alpha: string; beta: string }>(
      `SELECT alpha, beta FROM personas WHERE persona_name = $1`,
      [chosenPersona],
    );
    alphaBefore = Number(preP.rows[0].alpha);
    betaBefore = Number(preP.rows[0].beta);

    // ─── Step 6: Voice (must skip — shadow mode) ────────────────────────
    console.log('[6] Voice (shadow)');
    const vJob = (await callQ.getJobs(['waiting', 'prioritized', 'active']))
      .find((j) => j.data.pipelineLoadId === pipelineLoadId);
    const vResult = await voice.process(vJob!.data);
    await (voice as any).updatePipelineLoad(pipelineLoadId, vResult);
    console.log(`    skipped=${vResult.details?.skipped} reason=${vResult.details?.reason}`);

    // ─── Simulated webhook: flip stage to 'booked' with agreed rate ─────
    // In production this is the Retell webhook → call parser → enqueue
    // dispatch path. For the checkpoint we set the DB state directly so
    // we can drive the Dispatcher.
    console.log('[--] Simulating webhook outcome: booked at $2200');
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'booked',
           stage_updated_at = NOW(),
           agreed_rate = 2200, agreed_rate_currency = 'CAD',
           profit = 470, call_outcome = 'booked'
       WHERE id = $1`,
      [pipelineLoadId],
    );
    // Insert a stub agent_calls row so the Feedback worker has persona context.
    await db.query(
      `INSERT INTO agent_calls (
         pipeline_load_id, call_id, call_type, persona, language, currency,
         retell_call_id, retell_agent_id, phone_number_called,
         call_initiated_at, call_ended_at, duration_seconds,
         outcome, agreed_rate, profit, profit_tier, auto_book_eligible,
         sentiment, objections, concessions_made, next_action, created_at
       ) VALUES (
         $1, $2, 'outbound_shipper', $3, 'en', 'CAD',
         $2, 'agent_x', '+17055551861',
         NOW(), NOW(), 280,
         'booked', 2200, 470, 'good', true,
         'positive', '[]', 1, 'send_confirmation', NOW()
       )`,
      [pipelineLoadId, `mock_call_${RUN}`, chosenPersona],
    );
    // Pre-create the loads row Dispatcher will UPDATE for pipeline-linkage
    await db.query(
      `INSERT INTO loads (id, origin, destination, source, status, revenue, created_at)
       VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, NOW())`,
      [FAKE_TMS_LOAD_ID],
    );

    // ─── Step 7: Dispatcher ─────────────────────────────────────────────
    console.log('[7] Dispatcher (mocked TMS routes)');
    const dResult = await dispatcher.process({
      pipelineLoadId,
      loadId: `${RUN}-A`,
      loadBoardSource: 'manual',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: `mock_call_${RUN}`,
    });
    await (dispatcher as any).updatePipelineLoad(pipelineLoadId, dResult);
    console.log(`    tms_load_id=${dResult.details?.tmsLoadId}, TMS hits=[${tmsHits.join(', ')}]`);

    // ─── Simulate POD: TMS load delivered → pipeline load delivered ─────
    console.log('[--] Simulating POD upload (TMS Delivered → pipeline delivered)');
    await db.query(`UPDATE loads SET status = 'Delivered' WHERE id = $1`, [FAKE_TMS_LOAD_ID]);
    await db.query(
      `UPDATE pipeline_loads SET stage = 'delivered', delivered_at = NOW() WHERE id = $1`,
      [pipelineLoadId],
    );

    // ─── Step 8: Feedback ───────────────────────────────────────────────
    console.log('[8] Feedback');
    const fResult = await feedback.process({
      pipelineLoadId,
      loadId: `${RUN}-A`,
      loadBoardSource: 'manual',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
    });
    await (feedback as any).updatePipelineLoad(pipelineLoadId, fResult);
    console.log(
      `    accuracy=${fResult.details?.rateAccuracy != null ? (fResult.details.rateAccuracy * 100).toFixed(1) + '%' : 'n/a'}, profit=$${fResult.details?.profit}`,
    );

    // ─── Final assertions ───────────────────────────────────────────────
    const totalMs = Date.now() - startedAt;
    const stage = (await db.query<{ stage: string; tms_load_id: string }>(
      `SELECT stage, tms_load_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    )).rows[0];
    const personaAfter = await db.query<{ alpha: string; beta: string }>(
      `SELECT alpha, beta FROM personas WHERE persona_name = $1`,
      [chosenPersona],
    );
    const pref = await db.query<{ avg_agreed_rate: string; total_bookings: number }>(
      `SELECT avg_agreed_rate, total_bookings FROM shipper_preferences WHERE phone = '+17055551861'`,
    );

    console.log('\n=== SPRINT 5 CHECKPOINT SUMMARY ===');
    console.log(`pipeline_load id:     ${pipelineLoadId}`);
    console.log(`Final stage:          ${stage.stage}`);
    console.log(`tms_load_id:          ${stage.tms_load_id}`);
    console.log(`brief id:             ${briefId}`);
    console.log(`persona chosen:       ${chosenPersona}`);
    console.log(`α before / after:     ${alphaBefore} → ${personaAfter.rows[0].alpha}`);
    console.log(`β before / after:     ${betaBefore} → ${personaAfter.rows[0].beta}`);
    console.log(`Retell hits:          ${retellHits}`);
    console.log(`TMS hits:             ${tmsHits.length}`);
    console.log(`shipper avg rate:     $${pref.rows[0]?.avg_agreed_rate ?? 'n/a'}`);
    console.log(`Total time:           ${totalMs}ms`);

    const checks: Array<[string, boolean]> = [
      ['stage advanced to scored', stage.stage === 'scored'],
      ['tms_load_id linked', stage.tms_load_id === FAKE_TMS_LOAD_ID],
      ['Dispatcher hit all 4 TMS routes', tmsHits.length === 4],
      ['no Retell calls placed (shadow)', retellHits === 0],
      [
        'persona α incremented by 1',
        Math.abs(Number(personaAfter.rows[0].alpha) - (alphaBefore + 1)) < 0.01,
      ],
      ['persona β unchanged', Math.abs(Number(personaAfter.rows[0].beta) - betaBefore) < 0.01],
      [
        'shipper_preferences avg_agreed_rate = 2200',
        Number(pref.rows[0]?.avg_agreed_rate) === 2200,
      ],
    ];

    let allPass = true;
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) allPass = false;
    }
    console.log(`\nSprint 5 checkpoint: ${allPass ? 'PASS' : 'FAIL'}`);
    if (!allPass) process.exitCode = 1;
  } catch (err) {
    console.error('\nCheckpoint failed:', err);
    process.exitCode = 1;
  } finally {
    // Cleanup
    if (chosenPersona) {
      await db.query(
        `UPDATE personas SET alpha = $2, beta = $3,
           total_calls = GREATEST(total_calls - 1, 0),
           total_bookings = GREATEST(total_bookings - 1, 0)
         WHERE persona_name = $1`,
        [chosenPersona, alphaBefore, betaBefore],
      );
    }
    if (briefId) await db.query(`DELETE FROM negotiation_briefs WHERE id = $1`, [briefId]);
    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [`${RUN}-A`]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [FAKE_TMS_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM shipper_preferences WHERE phone = '+17055551861'`);

    await Promise.all([
      qualifyQ.obliterate({ force: true }).then(() => qualifyQ.close()),
      researchQ.obliterate({ force: true }).then(() => researchQ.close()),
      matchQ.obliterate({ force: true }).then(() => matchQ.close()),
      briefQ.obliterate({ force: true }).then(() => briefQ.close()),
      callQ.obliterate({ force: true }).then(() => callQ.close()),
      dispatchQ.obliterate({ force: true }).then(() => dispatchQ.close()),
      feedbackQ.obliterate({ force: true }).then(() => feedbackQ.close()),
    ]);
    await new Promise<void>((resolve) => retellMock.close(() => resolve()));
    await new Promise<void>((resolve) => tmsMock.close(() => resolve()));
    global.Date = RealDate;
  }
}

main().then(() => process.exit(process.exitCode ?? 0));
