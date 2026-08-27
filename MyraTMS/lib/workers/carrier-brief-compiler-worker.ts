/**
 * E2-04 M5 — CARRIER BRIEF COMPILER WORKER
 *
 * "Repackage the load and sell it back to a carrier" (the user's own words
 * from the architecture brainstorm this PRD came out of). A shipper has
 * confirmed the load in writing (stage='shipper_confirmed', M3); this
 * worker computes what a carrier needs to be sold: the already-ranked
 * carrier stack (from Agent 4/Ranker, unchanged since it ran early in the
 * pipeline), a negotiation envelope computed from confirmed_rate (not
 * agreed_rate — confirmed_rate is the source of truth for carrier math from
 * M3 onward per this PRD), and a Thompson-Sampled persona drawn from the
 * outbound_carrier pool (M1) — closing that pool's other half; nothing
 * before this worker ever read from it.
 *
 * THE LAST LINE OF process() IS THE ACTUAL POINT OF THIS WHOLE PRD: it's
 * the first thing anywhere in this codebase that enqueues carrier-call-queue
 * for a load that has never been cascaded before. Two full sessions of
 * E2-03 built the cascade state machine and the dial worker with nothing
 * upstream of them ever firing the first job — this closes that gap.
 *
 * The computed brief is persisted to pipeline_loads.carrier_brief (JSONB,
 * migration 048) rather than only carried in the BullMQ job payload,
 * because retell-webhook.ts's enqueueCascadeStep() rebuilds every cascade
 * retry's payload from scratch (cascadePosition/voicemailRetryCount only)
 * — anything living only in the first job's data would vanish the moment a
 * carrier doesn't pick up. carrier-voice-worker.ts reads it back fresh on
 * every dial attempt.
 *
 * No stage advance: carrier-side activity has never moved pipeline_loads.
 * stage (carrier-voice-worker.ts and retell-webhook.ts's carrier branch
 * both document this same choice) — only the shipper-side stage machine
 * governs `stage`, and the Dispatcher is what eventually flips
 * 'shipper_confirmed' to 'dispatched' once a carrier is secured (M6).
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { calculateCarrierNegotiationParams } from '@/lib/pipeline/cost-calculator';
import { selectPersona, PersonaStats } from '@/lib/pipeline/persona-selector';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface CarrierBriefJobPayload extends BaseJobPayload {}

const CASCADE_DEPTH = 5; // matches carrier-voice-worker.ts's DEFAULT_CASCADE_DEPTH (PRD §12-D4)

interface PipelineLoadRow {
  id: number;
  load_id: string;
  stage: string;
  confirmed_rate: string | null;
  confirmed_rate_currency: string | null;
  agreed_rate: string | null;
  agreed_rate_currency: string | null;
  // F4 (closes V4): E2-01 M1's qualifier-worker.ts classifies this, but not
  // every load path runs through that classification (or it can be NULL if
  // qualification predates the column). Nullable end to end -- the brief
  // degrades explicitly rather than crashing when it's missing.
  load_source_class: string | null;
}

interface MatchResultRow {
  carrier_id: string;
  match_score: string;
}

interface CarrierPersonaRow extends PersonaStats {
  retell_agent_id_en: string | null;
}

export interface CarrierBrief {
  carrierStack: string[];
  envelope: { ceiling: number; target: number; openingOffer: number; currency: string };
  persona: { name: string; sampledValue: number } | null;
  retellAgentId: string | null;
  generatedAt: string;
  // F4 (closes V4): E2-04 PRD §10 -- lets the carrier-facing agent truthfully
  // answer "is this your freight or are you double-brokering it?" Null when
  // qualifier-worker.ts never classified this load (logged as a warning
  // below, not treated as an error -- the brief still compiles).
  loadSourceClass: string | null;
}

export class CarrierBriefCompilerWorker extends BaseWorker<CarrierBriefJobPayload> {
  private carrierCallQueue: Queue;

  constructor(redis: Redis, carrierCallQueue: Queue) {
    const config: WorkerConfig = {
      queueName: 'carrier-brief-queue',
      expectedStage: 'shipper_confirmed',
      // No nextStage — see file header. Carrier-side work never advances
      // pipeline_loads.stage; a direct db.query() below handles the one
      // real mutation this worker makes (carrier_brief).
      nextStage: undefined,
      concurrency: 20,
      retryConfig: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
      },
      redis,
    };
    super(config);
    this.carrierCallQueue = carrierCallQueue;
  }

  public async process(payload: CarrierBriefJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;

    const load = await this.fetchLoad(pipelineLoadId);
    if (!load) {
      logger.warn(`[CarrierBriefCompiler] Load ${pipelineLoadId} not found`);
      return { success: true, pipelineLoadId, stage: 'unknown', duration: 0, details: { skipped: 'not_found' } };
    }
    if (load.stage !== 'shipper_confirmed') {
      logger.debug(`[CarrierBriefCompiler] Load ${pipelineLoadId} not at 'shipper_confirmed' (is '${load.stage}') — skipping`);
      return { success: true, pipelineLoadId, stage: load.stage, duration: 0, details: { skipped: 'stage_mismatch' } };
    }

    const carrierStack = await this.fetchCarrierStack(load.load_id);
    if (carrierStack.length === 0) {
      await this.escalateNoCarriers(load);
      return { success: true, pipelineLoadId, stage: 'escalated', duration: 0, details: { escalated: true, reason: 'no_ranked_carriers' } };
    }

    // Source of truth from M3 onward — never agreed_rate. Falls back for
    // defensive safety only (a load that somehow reaches this worker
    // without a confirmed_rate, e.g. a pre-E2-04 row in a mixed-deploy
    // window) — the normal path through submitConfirmation()/
    // recordVerbalConfirmation() always sets confirmed_rate.
    const rate = Number(load.confirmed_rate ?? load.agreed_rate ?? 0);
    const currency = ((load.confirmed_rate_currency ?? load.agreed_rate_currency) as 'CAD' | 'USD' | null) ?? 'CAD';
    const envelope = calculateCarrierNegotiationParams(rate, currency);

    const { persona, retellAgentId } = await this.selectCarrierPersona();
    if (!persona) {
      // Expected pre-launch state, not a bug: the 3 outbound_carrier
      // personas seed is_active=false until the operator configures real
      // Retell agent ids (migration 046's own header documents this).
      // Escalate rather than dial with no persona/agent at all.
      await this.escalateNoPersona(load);
      return { success: true, pipelineLoadId, stage: 'escalated', duration: 0, details: { escalated: true, reason: 'no_active_carrier_persona' } };
    }

    if (!load.load_source_class) {
      logger.warn(`[CarrierBriefCompiler] Load ${pipelineLoadId} has no load_source_class -- brief will carry it as null`);
    }

    const brief: CarrierBrief = {
      carrierStack,
      envelope: { ...envelope },
      persona: { name: persona.persona_name, sampledValue: persona.sampled_value },
      retellAgentId,
      generatedAt: new Date().toISOString(),
      loadSourceClass: load.load_source_class,
    };

    await db.query(
      `UPDATE pipeline_loads SET carrier_brief = $2, updated_at = NOW() WHERE id = $1`,
      [pipelineLoadId, JSON.stringify(brief)],
    );

    // THE LINE THIS WHOLE PRD EXISTS FOR: the first-ever real enqueue to
    // carrier-call-queue for a load that has never been cascaded before.
    await this.carrierCallQueue.add('cascade-step', {
      pipelineLoadId,
      loadId: load.load_id,
      loadBoardSource: '',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      cascadePosition: 0,
      voicemailRetryCount: 0,
    });

    logger.info(
      `[CarrierBriefCompiler] Load ${pipelineLoadId} brief compiled — stack=[${carrierStack.join(', ')}], ` +
      `envelope ceiling=${envelope.ceiling} target=${envelope.target} opening=${envelope.openingOffer} ${currency}, ` +
      `persona=${persona.persona_name}. carrier-call-queue enqueued.`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: load.stage,
      duration: 0,
      details: { briefCompiled: true, carrierStack, persona: persona.persona_name },
    };
  }

  private async fetchLoad(pipelineLoadId: number): Promise<PipelineLoadRow | null> {
    const r = await db.query<PipelineLoadRow>(
      `SELECT id, load_id, stage, confirmed_rate, confirmed_rate_currency, agreed_rate, agreed_rate_currency, load_source_class
         FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    return r.rows[0] ?? null;
  }

  // Same query pattern carrier-voice-worker.ts's fetchCascadeStack() already
  // uses — match_results was populated early in the pipeline by Agent 4
  // (Ranker), long before the shipper was ever called. Reused verbatim, not
  // recomputed: the ranking is still valid, nothing about carrier fitness
  // changed between then and the shipper confirming.
  private async fetchCarrierStack(loadId: string): Promise<string[]> {
    const r = await db.query<MatchResultRow>(
      `SELECT carrier_id, match_score FROM match_results
       WHERE load_id = $1
       ORDER BY match_score DESC
       LIMIT $2`,
      [loadId, CASCADE_DEPTH],
    );
    return r.rows.map((row) => row.carrier_id);
  }

  private async selectCarrierPersona(): Promise<{ persona: ReturnType<typeof selectPersona> | null; retellAgentId: string | null }> {
    const r = await db.query<CarrierPersonaRow>(
      `SELECT id, persona_name, alpha::numeric AS alpha, beta::numeric AS beta,
              total_calls, retell_agent_id_en
       FROM personas
       WHERE is_active = true AND call_type = 'outbound_carrier'`,
    );
    if (r.rows.length === 0) return { persona: null, retellAgentId: null };

    const stats: PersonaStats[] = r.rows.map((row) => ({
      id: row.id,
      persona_name: row.persona_name,
      alpha: Number(row.alpha),
      beta: Number(row.beta),
      total_calls: row.total_calls,
    }));
    const winner = selectPersona(stats);
    const winnerRow = r.rows.find((row) => row.id === winner.persona_id);
    return { persona: winner, retellAgentId: winnerRow?.retell_agent_id_en ?? null };
  }

  private async escalateNoCarriers(load: PipelineLoadRow): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [load.id],
    );
    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, NULL, 'carrier_brief_no_carriers', 'high', $1, $2,
         $3, 'carrier_brief_no_carriers', $4, NOW() + INTERVAL '4 hours'
       )`,
      [
        `No ranked carriers for confirmed load ${load.load_id}`,
        `Load ${load.load_id} was confirmed by the shipper but has no match_results rows — the Ranker never found an eligible carrier for this lane/equipment. Source a carrier manually.`,
        load.id,
        'Find and assign a carrier manually for this load.',
      ],
    );
    logger.warn(`[CarrierBriefCompiler] Load ${load.id} escalated: no ranked carriers in match_results`);
  }

  private async escalateNoPersona(load: PipelineLoadRow): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [load.id],
    );
    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, NULL, 'carrier_brief_no_persona', 'high', $1, $2,
         $3, 'carrier_brief_no_persona', $4, NOW() + INTERVAL '4 hours'
       )`,
      [
        `No active carrier-calling persona for confirmed load ${load.load_id}`,
        `Load ${load.load_id} was confirmed by the shipper but no 'outbound_carrier' persona is active yet — the 3 seeded carrier personas default is_active=false until a real Retell agent id is configured for each. Secure a carrier manually until AI carrier calling is turned on.`,
        load.id,
        'Configure and activate at least one outbound_carrier Retell agent, or secure this carrier manually.',
      ],
    );
    logger.warn(`[CarrierBriefCompiler] Load ${load.id} escalated: no active outbound_carrier persona`);
  }
}
