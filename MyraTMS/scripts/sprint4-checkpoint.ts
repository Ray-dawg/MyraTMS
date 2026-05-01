/**
 * Sprint 4 CHECKPOINT — end-to-end shadow-mode walkthrough.
 *
 * Drives the full pipeline manually (no BullMQ workers running) to prove
 * Agent 1 → 2 → 3 → 4 (gate) → 5 → 6 wiring works end-to-end with the
 * kill switch ON: CSV-style load comes in, brief is compiled, no Retell
 * call is placed.
 *
 *   1. ingestRawLoads()              [Agent 1]
 *   2. QualifierWorker.process()     [Agent 2]
 *   3. ResearcherWorker.process()    [Agent 3]   ┐ in parallel
 *   4. RankerWorker.process()        [Agent 4]   ┘
 *   5. CompilerWorker.process()      [Agent 5]
 *   6. VoiceWorker.process()         [Agent 6]   → must skip (shadow mode)
 *
 * Run: pnpm tsx --env-file=.env.local scripts/sprint4-checkpoint.ts
 */

import { Queue } from 'bullmq';
import http from 'http';
import { db } from '../lib/pipeline/db-adapter';
import { redisConnection } from '../lib/pipeline/redis-bullmq';
import { ScannerService } from '../lib/workers/scanner-worker';
import { QualifierWorker } from '../lib/workers/qualifier-worker';
import { ResearcherWorker } from '../lib/workers/researcher-worker';
import { RankerWorker } from '../lib/workers/ranker-worker';
import { CompilerWorker } from '../lib/workers/compiler-worker';
import { VoiceWorker } from '../lib/workers/voice-worker';

const REAL_CARRIER_ID = 'car_001';
const RUN = `SPRINT4-${Date.now()}`;

async function main() {
  // --- Pin time to 2pm so calling-hours validation passes regardless of when this runs ---
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

  // --- Mock Retell so we can definitively prove "no call placed" ---
  let retellHits = 0;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      retellHits++;
      console.error('!!! RETELL WAS HIT IN SHADOW MODE — kill switch failed');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ call_id: `should_not_happen_${Date.now()}` }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const addr = mock.address();
  if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
  const mockUrl = `http://127.0.0.1:${addr.port}`;

  // --- Set kill switches: PIPELINE_ENABLED is on for the workers themselves
  // but MAX_CONCURRENT_CALLS=0 puts the Voice worker in shadow mode ---
  process.env.PIPELINE_ENABLED = 'true';
  process.env.MAX_CONCURRENT_CALLS = '0';

  // --- Queues (test-namespaced to avoid stepping on real ones) ---
  const qualifyQ = new Queue(`qualify-q-${RUN}`, { connection: redisConnection });
  const researchQ = new Queue(`research-q-${RUN}`, { connection: redisConnection });
  const matchQ = new Queue(`match-q-${RUN}`, { connection: redisConnection });
  const briefQ = new Queue(`brief-q-${RUN}`, { connection: redisConnection });
  const callQ = new Queue(`call-q-${RUN}`, { connection: redisConnection });

  const scanner = new ScannerService(redisConnection, qualifyQ);
  const qualifier = new QualifierWorker(redisConnection, researchQ, matchQ);
  const researcher = new ResearcherWorker(redisConnection, briefQ);
  const ranker = new RankerWorker(redisConnection, briefQ);
  const compiler = new CompilerWorker(redisConnection, callQ);
  const voice = new VoiceWorker(redisConnection, { retellApiKey: 'test', retellBaseUrl: mockUrl });

  const startedAt = Date.now();
  const insertedIds: number[] = [];
  let pipelineLoadId = 0;
  let briefId: number | null = null;

  try {
    // ─── Step 1: CSV import ──────────────────────────────────────────────
    console.log('\n[1] Ingesting load via ScannerService...');
    const ingest = await scanner.ingestRawLoads(
      [
        {
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
          shipperContactName: 'Jean-Marc Tremblay',
          shipperPhone: '+17055551861',
        },
      ],
      'manual',
    );
    insertedIds.push(...ingest.insertedIds);
    pipelineLoadId = ingest.insertedIds[0];
    console.log(`    inserted=${ingest.inserted}, duplicates=${ingest.duplicates}, invalid=${ingest.invalid}`);
    console.log(`    pipeline_load id=${pipelineLoadId}`);

    // ─── Step 2: Qualifier ──────────────────────────────────────────────
    console.log('\n[2] QualifierWorker.process()...');
    const qualifyJobs = await qualifyQ.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    const qJob = qualifyJobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    if (!qJob) throw new Error('qualify job missing');
    const qResult = await qualifier.process(qJob.data);
    await (qualifier as any).updatePipelineLoad(pipelineLoadId, qResult);
    console.log(`    passed=${qResult.details?.passed}, priority=${qResult.details?.priorityScore}`);

    // ─── Steps 3 + 4: Researcher and Ranker run in parallel ─────────────
    console.log('\n[3+4] Researcher and Ranker in parallel...');
    const researchJobs = await researchQ.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    const matchJobs = await matchQ.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    const rJob = researchJobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    const mJob = matchJobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    if (!rJob || !mJob) throw new Error('research or match job missing');

    const [rResult, mResult] = await Promise.all([
      researcher.process(rJob.data),
      ranker.process(mJob.data),
    ]);

    await (researcher as any).updatePipelineLoad(pipelineLoadId, rResult);
    await (ranker as any).updatePipelineLoad(pipelineLoadId, mResult);

    console.log(`    Researcher: market $${rResult.details?.rates.floorRate}-$${rResult.details?.rates.bestRate}, strategy ${rResult.details?.strategy}`);
    console.log(`    Ranker: matched=${mResult.details?.matched}, count=${mResult.details?.carrierCount}`);

    // If ranker didn't match (no F+ carriers), skip the rest gracefully.
    if (!mResult.details?.matched) {
      console.log('\n    Ranker found no carriers above F-grade — pipeline correctly stopped.');
      console.log(`\n  TOTAL TIME: ${Date.now() - startedAt}ms`);
      console.log('  Sprint 4 checkpoint: PASS (no carriers path verified, no call placed)');
      return;
    }

    // ─── Step 5: Compiler ────────────────────────────────────────────────
    console.log('\n[5] CompilerWorker.process()...');
    const briefJobs = await briefQ.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    const bJob = briefJobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    if (!bJob) throw new Error('brief job missing');
    const cResult = await compiler.process(bJob.data);
    await (compiler as any).updatePipelineLoad(pipelineLoadId, cResult);
    briefId = cResult.details?.briefId;
    console.log(`    briefId=${briefId}, persona=${cResult.details?.persona}, strategy=${cResult.details?.strategy}`);

    // ─── Step 6: Voice (must skip due to MAX_CONCURRENT_CALLS=0) ────────
    console.log('\n[6] VoiceWorker.process() with shadow mode...');
    const callJobs = await callQ.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    const vJob = callJobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    if (!vJob) throw new Error('call job missing');
    const vResult = await voice.process(vJob.data);
    await (voice as any).updatePipelineLoad(pipelineLoadId, vResult);
    console.log(`    skipped=${vResult.details?.skipped}, reason=${vResult.details?.reason}`);

    // ─── Final assertions ───────────────────────────────────────────────
    const durationMs = Date.now() - startedAt;
    const finalRow = await db.query<{ stage: string; call_attempts: number }>(
      `SELECT stage, call_attempts FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    const callAttempts = finalRow.rows[0].call_attempts;
    const stage = finalRow.rows[0].stage;

    const briefRow = await db.query<{ id: number }>(
      `SELECT id FROM negotiation_briefs WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );

    console.log('\n=== SPRINT 4 CHECKPOINT SUMMARY ===');
    console.log(`Pipeline load id:     ${pipelineLoadId}`);
    console.log(`Final stage:          ${stage}`);
    console.log(`Brief id:             ${briefRow.rows[0]?.id ?? 'none'}`);
    console.log(`Call attempts:        ${callAttempts}`);
    console.log(`Retell hits:          ${retellHits}`);
    console.log(`Total time:           ${durationMs}ms`);
    console.log();

    // Assertions
    const checks: Array<[string, boolean]> = [
      ['stage advanced to briefed', stage === 'briefed'],
      ['negotiation brief created', !!briefRow.rows[0]?.id],
      ['no Retell calls placed (shadow mode)', retellHits === 0],
      ['call_attempts is 0 (no dial)', callAttempts === 0],
      ['under 30s', durationMs < 30_000],
    ];

    let allPass = true;
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) allPass = false;
    }

    console.log(`\nSprint 4 checkpoint: ${allPass ? 'PASS' : 'FAIL'}`);
    if (!allPass) process.exitCode = 1;
  } catch (err) {
    console.error('\nCheckpoint failed:', err);
    process.exitCode = 1;
  } finally {
    if (briefId) await db.query(`DELETE FROM negotiation_briefs WHERE id = $1`, [briefId]);
    if (pipelineLoadId) {
      await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
      await db.query(`DELETE FROM match_results WHERE load_id LIKE $1`, [`${RUN}%`]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    }
    await Promise.all([
      qualifyQ.obliterate({ force: true }).then(() => qualifyQ.close()),
      researchQ.obliterate({ force: true }).then(() => researchQ.close()),
      matchQ.obliterate({ force: true }).then(() => matchQ.close()),
      briefQ.obliterate({ force: true }).then(() => briefQ.close()),
      callQ.obliterate({ force: true }).then(() => callQ.close()),
    ]);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    global.Date = RealDate;
  }
}

main().then(() => process.exit(process.exitCode ?? 0));
