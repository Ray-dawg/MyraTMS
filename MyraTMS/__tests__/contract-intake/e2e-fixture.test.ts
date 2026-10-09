// T-30 acceptance criterion 6 -- authorized sender -> approved tender ->
// real Ranker/Feedback workers (unmodified) -> finalize-booking -> booked,
// with booked_via='email_tender' and ZERO agent_calls rows, plus concrete proof
// that downstream code reading agent_calls by pipeline_load_id
// (feedback-worker.ts gatherContext, a LEFT JOIN LATERAL) degrades gracefully.
//
// Follows __tests__/pipeline/ranker.test.ts: real Redis, worker instantiated and
// .process() called directly, bypassing BullMQ job lifecycle. The direct
// pipeline_loads INSERT is a FIXTURE standing in for the Task 9 approve branch; the
// "no pipeline_loads INSERT in production code" rule does not apply to tests.
//
// NOTE: finalizeMatchedTenders() has no scoping argument, so it books every
// 'matched' email_tender row visible to it. Only this test's row is asserted on.
import { describe, it, expect, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { RankerWorker, type MatchJobPayload } from '@/lib/workers/ranker-worker';
import { FeedbackWorker } from '@/lib/workers/feedback-worker';
import { finalizeMatchedTenders } from '@/lib/contract-intake/finalize-booking';

const STAMP = Date.now();
const TEST_LOAD_ID = `TEST-T30-E2E-${STAMP}`;
const TEST_CARRIER_ID = `TEST-T30-E2E-CAR-${STAMP}`;

// Collected ids so cleanup never depends on a single variable surviving.
const pipelineLoadIds: number[] = [];
const carrierIds: string[] = [];
const workers: Array<{ shutdown(): Promise<void> }> = [];
let briefQueue: Queue | undefined;

describe('T-30 end-to-end fixture (acceptance criterion 6)', () => {
  afterAll(async () => {
    for (const id of pipelineLoadIds) {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [id]);
      await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [id]);
    }
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
    for (const id of pipelineLoadIds) {
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [id]); // events cascade
    }
    for (const id of carrierIds) {
      await db.query(`DELETE FROM carrier_equipment WHERE carrier_id = $1`, [id]);
      await db.query(`DELETE FROM carriers WHERE id = $1`, [id]);
    }
    for (const w of workers) await w.shutdown().catch(() => {});
    await briefQueue?.obliterate({ force: true }).catch(() => {});
    await briefQueue?.close();
  });

  it('approved email-tender load reaches booked via real Ranker + finalize-booking, with zero agent_calls and no downstream error', async () => {
    // Carrier that clears the hard filter (Active authority, unexpired insurance,
    // Dry Van equipment) and scores above F with NO load history. The Ranker's
    // request carries no originLat/originLng, so proximity returns its 0.5
    // neutral default rather than a distance-derived value: lane 0 (x0.30)
    // + proximity 0.5 (x0.25) + rate 0.5 (x0.20) + reliability 0.5 (x0.15, NEW)
    // + relationship 0.1 (x0.10) => ~0.31, grade D. Above F, so the Ranker
    // MATCHES rather than disqualifies.
    //
    // This seeding is what makes the test independent of ambient DB state: on a
    // freshly-cut verification branch with no other eligible carriers, this row
    // alone keeps the load viable. On t30-verify other carriers already exist
    // and maxResults is 3, so the top pick is usually one of those -- the
    // assertions below hold either way, but do not read a passing run as proof
    // that THIS carrier was selected.
    carrierIds.push(TEST_CARRIER_ID);
    await db.query(
      `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
         authority_status, insurance_status, insurance_expiry,
         liability_insurance, cargo_insurance, safety_rating,
         carrier_status, contact_phone, created_at, updated_at)
       VALUES ($1, $2, 'T30 E2E Test Carrier', '', '', 'Active', 'Active',
         CURRENT_DATE + INTERVAL '1 year', 750000, 100000, 'Not Rated',
         'active', '+15550009999', NOW(), NOW())`,
      [TEST_CARRIER_ID, LEGACY_DEFAULT_TENANT_ID],
    );
    await db.query(
      `INSERT INTO carrier_equipment (id, carrier_id, equipment_type)
       VALUES ($1, $2, 'Dry Van')`,
      [`CE-${TEST_CARRIER_ID}`, TEST_CARRIER_ID],
    );

    // Step 1 -- the row the Task 9 approval produces (fixture INSERT).
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, stage, source_type, priority_score, estimated_margin_high,
         research_completed_at, market_rate_floor, market_rate_mid, market_rate_best,
         recommended_strategy
       ) VALUES (
         $1, 'email_tender', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van', 3000, 'USD',
         920, 'qualified', 'email_tender', 500, 600,
         NOW(), 2500, 2700, 2900, 'standard'
       ) RETURNING id`,
      [TEST_LOAD_ID],
    );
    const pipelineLoadId = inserted.rows[0].id;
    pipelineLoadIds.push(pipelineLoadId);

    // Step 2 -- real, unmodified RankerWorker.
    briefQueue = new Queue('brief-queue-test-t30', { connection: redisConnection });
    const ranker = new RankerWorker(redisConnection, briefQueue);
    workers.push(ranker);
    const matchPayload: MatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'email_tender',
      enqueuedAt: new Date().toISOString(),
      priority: 500,
      qualifiedLoad: {
        origin: { city: 'Chicago', state: 'IL', country: 'US' },
        destination: { city: 'Dallas', state: 'TX', country: 'US' },
        equipmentType: 'Dry Van',
        distanceMiles: 920,
        pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
        weightLbs: null,
      },
    };
    const matchResult = await ranker.process(matchPayload);
    expect(matchResult.success).toBe(true);
    // Guard against the vacuous disqualify path.
    expect(matchResult.details?.matched).toBe(true);
    expect(matchResult.details?.carrierCount).toBeGreaterThan(0);

    // process() does not write the stage; the BaseWorker lifecycle hook does
    // (same manual trigger as ranker.test.ts).
    await (ranker as any).updatePipelineLoad(pipelineLoadId, matchResult);

    const afterMatch = await db.query<{ stage: string; carrier_match_count: number }>(
      `SELECT stage, carrier_match_count FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(afterMatch.rows[0].stage).toBe('matched'); // not 'disqualified'
    expect(Number(afterMatch.rows[0].carrier_match_count)).toBeGreaterThan(0);

    // Step 3 -- the one new piece of T-30 orchestration.
    const finalizeResult = await finalizeMatchedTenders();
    expect(finalizeResult.finalized).toBeGreaterThanOrEqual(1);

    const afterBooked = await db.query<{
      stage: string; booked_via: string | null; agreed_rate: string | null;
    }>(
      `SELECT stage, booked_via, agreed_rate FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(afterBooked.rows[0].stage).toBe('booked');
    expect(afterBooked.rows[0].booked_via).toBe('email_tender');
    expect(Number(afterBooked.rows[0].agreed_rate)).toBe(3000);

    // Step 4 -- sanity check, NOT the proof of "zero voice calls".
    // Nothing in this test could create an agent_calls row: the only writers are
    // voice-worker, carrier-voice-worker, retell-webhook and sprint5-checkpoint,
    // none of which run here, and the test's brief queue has no consumer. So
    // this assertion would pass for almost any implementation; it only fires if
    // the Ranker or finalize path were changed to insert into agent_calls.
    // What STRUCTURALLY proves no call occurred is the stage path asserted
    // above -- matched -> booked, skipping 'briefed' and 'calling' entirely,
    // which are the only stages from which a voice call is ever placed.
    const calls = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM agent_calls WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(Number(calls.rows[0].c)).toBe(0);

    // Step 5 -- downstream agent_calls reader degrades gracefully.
    const feedback = new FeedbackWorker(redisConnection);
    workers.push(feedback);
    const ctx = await (feedback as any).gatherContext(pipelineLoadId);
    expect(ctx).not.toBeNull();
    expect(ctx.persona).toBeNull();
    expect(ctx.agreedRate).toBe(3000);
  }, 120_000);
});
