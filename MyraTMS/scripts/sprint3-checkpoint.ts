/**
 * Sprint 3 CHECKPOINT artifact generator.
 *
 * Inserts a synthetic Toronto → Sudbury load in 'matched' stage with research
 * already populated, runs the Compiler against live Neon + Upstash, and
 * pretty-prints both the NegotiationBrief and the Retell phone-call payload.
 *
 * Verifies that every retell_llm_dynamic_variable is a string (the Retell
 * API rejects anything else with a 400).
 *
 * Run: pnpm tsx --env-file=.env.local scripts/sprint3-checkpoint.ts
 */

import { Queue } from 'bullmq';
import { db } from '../lib/pipeline/db-adapter';
import { redisConnection } from '../lib/pipeline/redis-bullmq';
import { CompilerWorker, type BriefJobPayload } from '../lib/workers/compiler-worker';
import { validateBrief } from '../lib/pipeline/negotiation-brief';

async function main() {
  const TEST_LOAD_ID = `CHECKPOINT-${Date.now()}`;
  const TEST_PHONE = '+17055551861';
  const REAL_CARRIER_ID = 'car_001';

  // Pin clock to mid-day so calling-hours validation succeeds at any wall time.
  // We override both `Date.now` and the no-arg `new Date()` constructor; the
  // Compiler uses `new Date().getHours()` directly so patching `Date.now` alone
  // wasn't enough.
  const noon = new Date();
  noon.setHours(14, 0, 0, 0);
  const fixedTime = noon.getTime();
  const RealDate = Date;
  const realDateNow = Date.now;
  // @ts-expect-error — runtime monkey-patch
  global.Date = class extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixedTime);
      // @ts-expect-error — spreading varargs into Date is fine at runtime
      else super(...args);
    }
    static now() { return fixedTime; }
    static parse = RealDate.parse;
    static UTC = RealDate.UTC;
  };

  const callQueue = new Queue('call-queue-checkpoint', { connection: redisConnection });
  const worker = new CompilerWorker(redisConnection, callQueue);

  let pipelineLoadId = 0;
  let briefId: number | null = null;

  try {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
         distance_miles, distance_km, posted_rate, posted_rate_currency,
         shipper_company, shipper_contact_name, shipper_phone, shipper_email,
         stage, priority_score, estimated_margin_high,
         research_completed_at, market_rate_floor, market_rate_mid, market_rate_best,
         recommended_strategy, carrier_match_count, top_carrier_id
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 'grinding media', 42000,
         250, 402, 2400, 'CAD',
         'Northern Mine Supply Co', 'Jean-Marc Tremblay', $2, 'jm.tremblay@nmsco.ca',
         'matched', 700, 600,
         NOW(), 1700, 2100, 2500,
         'standard', 1, $3
       ) RETURNING id`,
      [TEST_LOAD_ID, TEST_PHONE, REAL_CARRIER_ID],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO match_results (load_id, carrier_id, match_score, match_grade, breakdown,
                                  was_selected, assignment_method, created_at)
       VALUES ($1, $2, 0.78, 'B', $3, false, 'auto', NOW())`,
      [
        TEST_LOAD_ID,
        REAL_CARRIER_ID,
        JSON.stringify({
          equipment: { match: true, score: 1 },
          lane_familiarity: { loads_on_lane: 2, score: 0.6 },
          proximity: { miles_from_origin: null, score: 0.5 },
          rate: { carrier_avg_rate: 1850, score: 0.85 },
          reliability: { on_time_pct: 93, score: 0.93 },
          relationship: { last_load_days_ago: 30, score: 0.6 },
        }),
      ],
    );

    const payload: BriefJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 700,
    };

    console.log('\n=== Running CompilerWorker.process() ===');
    const result = await worker.process(payload);
    briefId = result.details?.briefId ?? null;

    console.log('\n=== NEGOTIATION BRIEF (canonical schema) ===');
    console.log(JSON.stringify(result.details?.brief, null, 2));

    console.log('\n=== RETELL CREATE-PHONE-CALL PAYLOAD ===');
    const retell = result.details?.retellPayload;
    console.log(JSON.stringify(retell, null, 2));

    console.log('\n=== DYNAMIC VARIABLE TYPE CHECK ===');
    let stringCount = 0;
    let nonStringCount = 0;
    const violations: string[] = [];
    for (const [k, v] of Object.entries(retell.retell_llm_dynamic_variables)) {
      if (typeof v === 'string') {
        stringCount++;
      } else {
        nonStringCount++;
        violations.push(`  ${k}: ${typeof v} = ${JSON.stringify(v)}`);
      }
    }
    console.log(`String vars: ${stringCount}`);
    console.log(`Non-string vars: ${nonStringCount}`);
    if (violations.length) {
      console.log('Violations:');
      violations.forEach((v) => console.log(v));
    } else {
      console.log('All dynamic_variables are strings ✓ (Retell API contract satisfied)');
    }

    console.log('\n=== VALIDATION RE-RUN ===');
    const validation = validateBrief(result.details?.brief);
    console.log('Valid:', validation.valid);
    console.log('Errors:', validation.errors);
    console.log('Warnings:', validation.warnings);

    console.log('\n=== SUMMARY ===');
    console.log(`brief_id:        ${briefId}`);
    console.log(`persona:         ${retell.metadata.persona}`);
    console.log(`agent_id:        ${retell.agent_id}`);
    console.log(`from_number:     ${retell.from_number}`);
    console.log(`to_number:       ${retell.to_number}`);
    console.log(`strategy:        ${result.details?.brief.strategy.approach}`);
    console.log(`initial_offer:   $${retell.metadata.initialOffer}`);
    console.log(`final_offer:     $${retell.metadata.finalOffer}`);
    console.log(`total_cost:      $${retell.metadata.totalCost}`);
    console.log(`carrier_count:   ${result.details?.carrierCount}`);
  } catch (err) {
    console.error('\n=== CHECKPOINT FAILED ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    if (briefId) await db.query(`DELETE FROM negotiation_briefs WHERE id = $1`, [briefId]);
    if (pipelineLoadId) {
      await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    }
    await callQueue.obliterate({ force: true });
    await callQueue.close();
    global.Date = RealDate;
    Date.now = realDateNow;
  }
}

main().then(() => process.exit(process.exitCode ?? 0));
