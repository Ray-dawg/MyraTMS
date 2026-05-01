/**
 * AGENT 5 - BRIEF COMPILER WORKER
 *
 * Produces the canonical NegotiationBrief — a complete, self-contained JSON
 * document that the voice agent (Agent 6) consumes via Retell. Merges output
 * from Agent 3 (Researcher, persisted to pipeline_loads.market_rate_*) and
 * Agent 4 (Carrier Ranker, persisted to match_results), adds persona via
 * Thompson Sampling, attaches the objection playbook, runs compliance checks,
 * validates, persists to negotiation_briefs, and produces a Retell payload.
 *
 * This worker performs NO AI calls. It is pure template merge + math, target < 100ms.
 *
 * Input:  brief-queue with BriefJobPayload (after the parallel gate opens)
 * Output: negotiation_briefs row + Retell-ready payload, enqueued to call-queue
 * Next Stage: briefed (call-queue worker advances to 'calling' when it dials)
 */

import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import {
  calculateTotalCost,
  calculateNegotiationParams,
} from '@/lib/pipeline/cost-calculator';
import {
  selectPersona,
  type PersonaStats,
} from '@/lib/pipeline/persona-selector';
import {
  OBJECTION_PLAYBOOK,
  type ObjectionEntry,
} from '@/lib/pipeline/objection-playbook';
import {
  compileRetellPayload,
  validateBrief,
  type NegotiationBrief,
  type RetellCreatePhoneCallPayload,
} from '@/lib/pipeline/negotiation-brief';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface BriefJobPayload extends BaseJobPayload {
  researchResult?: any;
  carrierStack?: any[];
}

interface PipelineLoadRow {
  id: number;
  load_id: string;
  load_board_source: string;
  origin_city: string;
  origin_state: string;
  origin_country: string;
  destination_city: string;
  destination_state: string;
  destination_country: string;
  pickup_date: Date;
  delivery_date: Date | null;
  equipment_type: string;
  commodity: string | null;
  weight_lbs: number | null;
  distance_miles: number | null;
  distance_km: number | null;
  shipper_company: string | null;
  shipper_contact_name: string | null;
  shipper_phone: string | null;
  shipper_email: string | null;
  posted_rate: string | null;
  posted_rate_currency: string | null;
  market_rate_floor: string | null;
  market_rate_mid: string | null;
  market_rate_best: string | null;
  recommended_strategy: string | null;
  carrier_match_count: number | null;
  top_carrier_id: string | null;
}

const RETELL_WEBHOOK_URL =
  process.env.RETELL_WEBHOOK_URL || 'https://myratms.vercel.app/api/webhooks/retell-callback';
const RETELL_FUNCTION_URL =
  process.env.RETELL_FUNCTION_URL || 'https://myratms.vercel.app/api/webhooks/retell-function';
const CURRENT_FUEL_PRICE_CAD = 1.5;

export class CompilerWorker extends BaseWorker<BriefJobPayload> {
  private callQueue: Queue;

  constructor(redis: Redis, callQueue: Queue) {
    const config: WorkerConfig = {
      queueName: 'brief-queue',
      expectedStage: 'matched',
      nextStage: 'briefed',
      concurrency: 20,
      retryConfig: { attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
      redis,
    };
    super(config);
    this.callQueue = callQueue;
  }

  public async process(payload: BriefJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;
    logger.debug(`[Compiler] Compiling brief for load ${pipelineLoadId}`);

    const load = await this.fetchPipelineLoad(pipelineLoadId);
    if (!load) throw new Error(`pipeline_load ${pipelineLoadId} not found`);

    const carriers = await this.fetchCarrierStack(load.load_id);
    if (carriers.length === 0) {
      throw new Error(`No carriers in match_results for load ${load.load_id}`);
    }

    const persona = await this.selectPersonaFromDb();
    const compliance = await this.checkCompliance(load);
    const shipperHistory = await this.loadShipperHistory(load.shipper_phone);

    const brief = await this.assembleBrief(load, carriers, persona, compliance, shipperHistory);

    const validation = validateBrief(brief);
    if (!validation.valid) {
      logger.error(
        `[Compiler] Brief validation failed for load ${pipelineLoadId}: ${validation.errors.join('; ')}`,
      );
      throw new Error(`Brief validation failed: ${validation.errors.join('; ')}`);
    }
    if (validation.warnings.length > 0) {
      logger.warn(`[Compiler] Brief warnings for load ${pipelineLoadId}: ${validation.warnings.join('; ')}`);
    }

    const briefId = await this.persistBrief(brief);
    brief.meta.briefId = briefId;

    const retellPayload = compileRetellPayload(brief);

    logger.info(
      `[Compiler] Brief ${briefId} compiled for load ${pipelineLoadId}. ` +
        `Persona: ${persona.persona_name} (sample ${persona.sampled_value.toFixed(3)}). ` +
        `Strategy: ${brief.strategy.approach}. ` +
        `Ladder: $${brief.negotiation.initialOffer} → $${brief.negotiation.finalOffer}. ` +
        `Phone: ${logger.maskPhone(brief.shipper.phone)}.`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        briefId,
        strategy: brief.strategy.approach,
        persona: persona.persona_name,
        retellAgentId: retellPayload.agent_id,
        carrierCount: brief.carriers.length,
        validation,
        brief,
        retellPayload,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // BRIEF ASSEMBLY
  // ──────────────────────────────────────────────────────────────────────

  private async assembleBrief(
    load: PipelineLoadRow,
    carriers: NegotiationBrief['carriers'],
    persona: ReturnType<typeof selectPersona> & { retellAgentId: string },
    compliance: NegotiationBrief['compliance'],
    shipperHistory: {
      previousCallCount: number;
      previousOutcomes: string[];
      isRepeatShipper: boolean;
      lastBookedRate: number | null;
      lastBookedDate: string | null;
      fatigueScore: number;
      knownObjections: string[];
      preferredLanguage: 'en' | 'fr';
      preferredCurrency: 'CAD' | 'USD';
      notes: string | null;
    },
  ): Promise<NegotiationBrief> {
    const distanceMiles = Number(load.distance_miles ?? 0);
    const distanceKm = Number(load.distance_km ?? Math.round(distanceMiles * 1.60934));
    const isCrossBorder = load.origin_country !== load.destination_country;

    const cost = calculateTotalCost({
      distanceMiles,
      distanceKm,
      carrierRate: load.origin_country === 'CA' ? 2.0 : 1.5,
      fuelPricePerLitre: CURRENT_FUEL_PRICE_CAD,
      originCountry: load.origin_country,
      destinationCountry: load.destination_country,
      isCrossBorder,
    });

    const marketFloor = Number(load.market_rate_floor ?? 0);
    const marketMid = Number(load.market_rate_mid ?? 0);
    const marketBest = Number(load.market_rate_best ?? 0);
    const currency = ((load.posted_rate_currency || 'CAD') as 'CAD' | 'USD');
    const negotiation = calculateNegotiationParams(cost.total, currency, marketBest || Infinity);

    const minMargin = currency === 'CAD' ? 270 : 200;
    const targetMargin = currency === 'CAD' ? 470 : 350;
    const stretchMargin = currency === 'CAD' ? 675 : 500;

    const equipmentNormalized = this.normalizeEquipment(load.equipment_type);
    const equipmentDisplay = this.equipmentDisplayName(load.equipment_type);

    const pickupDate = load.pickup_date instanceof Date ? load.pickup_date : new Date(load.pickup_date);
    const deliveryDate = load.delivery_date
      ? load.delivery_date instanceof Date
        ? load.delivery_date
        : new Date(load.delivery_date)
      : null;

    const contactFirstName = load.shipper_contact_name
      ? load.shipper_contact_name.trim().split(/\s+/)[0] || null
      : null;

    const playbook = this.buildObjectionPlaybook(shipperHistory.knownObjections);

    const strategy = this.buildStrategy(
      (load.recommended_strategy as 'aggressive' | 'standard' | 'walk') ?? 'standard',
      negotiation,
      cost.total,
      currency,
      load,
    );

    const brief: NegotiationBrief = {
      meta: {
        briefId: 0,
        briefVersion: '2.0',
        pipelineLoadId: load.id,
        generatedAt: new Date().toISOString(),
        generatedBy: 'compiler-v2',
        parentBriefId: null,
        retryCount: 0,
      },
      load: {
        loadId: load.load_id,
        loadBoardSource: this.normalizeBoardSource(load.load_board_source),
        origin: {
          city: load.origin_city,
          state: load.origin_state,
          country: load.origin_country,
        },
        destination: {
          city: load.destination_city,
          state: load.destination_state,
          country: load.destination_country,
        },
        pickupDate: pickupDate.toISOString().split('T')[0],
        pickupTime: null,
        pickupDateFormatted: this.formatDateLong(pickupDate),
        deliveryDate: deliveryDate ? deliveryDate.toISOString().split('T')[0] : null,
        deliveryTime: null,
        deliveryDateFormatted: deliveryDate ? this.formatDateLong(deliveryDate) : null,
        equipmentType: equipmentNormalized,
        equipmentTypeDisplay: equipmentDisplay,
        commodity: load.commodity,
        weightLbs: load.weight_lbs,
        distanceMiles,
        distanceKm,
        crossBorder: isCrossBorder,
        specialRequirements: null,
        isHazmat: false,
        temperatureControlled: equipmentNormalized === 'reefer',
        temperatureRange: null,
      },
      shipper: {
        companyName: load.shipper_company,
        contactName: load.shipper_contact_name,
        contactFirstName,
        phone: load.shipper_phone || '',
        phoneFormatted: this.formatPhoneDisplay(load.shipper_phone || ''),
        email: load.shipper_email,
        preferredLanguage: shipperHistory.preferredLanguage,
        preferredCurrency: shipperHistory.preferredCurrency,
        previousCallCount: shipperHistory.previousCallCount,
        previousOutcomes: shipperHistory.previousOutcomes as any,
        fatigueScore: shipperHistory.fatigueScore,
        isRepeatShipper: shipperHistory.isRepeatShipper,
        lastBookedRate: shipperHistory.lastBookedRate,
        lastBookedDate: shipperHistory.lastBookedDate,
        averageResponseTime: null,
        knownObjections: shipperHistory.knownObjections,
        notes: shipperHistory.notes,
      },
      rates: {
        marketRateFloor: marketFloor,
        marketRateMid: marketMid,
        marketRateBest: marketBest,
        rateConfidence: 0.7,
        rateSources: ['benchmark'] as any,
        dataAge: 'just now',
        totalCost: cost.total,
        costBreakdown: {
          baseCost: cost.baseCost,
          deadheadCost: cost.deadheadCost,
          fuelSurcharge: cost.fuelSurcharge,
          accessorials: cost.accessorials,
          adminOverhead: cost.adminOverhead,
          crossBorderFees: cost.crossBorderFees,
          factoringFee: cost.factoringFee,
          insuranceSurcharge: 0,
        },
        currency,
        minMargin,
        targetMargin,
        stretchMargin,
        ratePerMile: distanceMiles > 0 ? Math.round((cost.total / distanceMiles) * 100) / 100 : 0,
        marketRatePerMile:
          distanceMiles > 0 && marketMid > 0
            ? Math.round((marketMid / distanceMiles) * 100) / 100
            : 0,
      },
      negotiation: {
        initialOffer: negotiation.initialOffer,
        concessionStep1: negotiation.concessionStep1,
        concessionStep2: negotiation.concessionStep2,
        finalOffer: negotiation.finalOffer,
        maxConcessions: negotiation.maxConcessions,
        concessionAsks: [
          'flexibility on the pickup appointment time',
          'a commitment to weekly loads on this lane',
          'an extended delivery window to end of day',
        ],
        walkAwayRate: negotiation.finalOffer,
        walkAwayScript:
          "I appreciate your time. I can't quite make the numbers work at that rate for this load, but I'd love to help with your next one. Keep us in mind — we run this corridor regularly.",
        initialOfferFormatted: this.formatCurrencyDisplay(negotiation.initialOffer, currency),
        concessionStep1Formatted: this.formatCurrencyDisplay(negotiation.concessionStep1, currency),
        concessionStep2Formatted: this.formatCurrencyDisplay(negotiation.concessionStep2, currency),
        finalOfferFormatted: this.formatCurrencyDisplay(negotiation.finalOffer, currency),
        currencyWord: currency === 'CAD' ? 'Canadian dollars' : 'US dollars',
      },
      strategy,
      carriers,
      persona: {
        personaName: persona.persona_name as 'assertive' | 'friendly' | 'analytical',
        personaLabel: `${this.capitalize(persona.persona_name)} ${shipperHistory.preferredLanguage.toUpperCase()}`,
        retellAgentId: persona.retellAgentId,
        selectionMethod: 'thompson_sampling',
        selectionScore: persona.sampled_value,
        voiceSettings: this.voiceSettingsFor(persona.persona_name),
      },
      objectionPlaybook: playbook,
      compliance,
      callConfig: {
        maxDurationSeconds: 300,
        language: shipperHistory.preferredLanguage,
        timezone: this.timezoneForState(load.shipper_phone || '', load.origin_state),
        retellWebhookUrl: RETELL_WEBHOOK_URL,
        retellFunctionUrl: RETELL_FUNCTION_URL,
        callbackOnNoAnswer: true,
        maxCallAttempts: 2,
        callPriority: 7,
        scheduledCallTime: null,
      },
    };

    return brief;
  }

  private buildObjectionPlaybook(
    knownObjections: string[],
  ): NegotiationBrief['objectionPlaybook'] {
    const known = new Set(knownObjections);
    const sorted = [...OBJECTION_PLAYBOOK].sort((a, b) => {
      const aPriority = known.has(a.type) ? 0 : 1;
      const bPriority = known.has(b.type) ? 0 : 1;
      return aPriority - bPriority;
    });

    return sorted.map((entry: ObjectionEntry, idx) => ({
      objectionType: entry.type,
      objectionLabel: entry.label,
      response: entry.primary_response,
      alternateResponse: null,
      followUpQuestion: entry.follow_up_question,
      escalateAfter: entry.escalation_threshold,
      priority: idx + 1,
    }));
  }

  private buildStrategy(
    approach: 'aggressive' | 'standard' | 'walk',
    negotiation: ReturnType<typeof calculateNegotiationParams>,
    totalCost: number,
    currency: 'CAD' | 'USD',
    load: PipelineLoadRow,
  ): NegotiationBrief['strategy'] {
    const expectedMargin = negotiation.initialOffer - totalCost;

    const reasoningMap: Record<typeof approach, string> = {
      aggressive: `Strong margin opportunity ($${expectedMargin} ${currency}) — push to stretch.`,
      standard: `Healthy margin ($${expectedMargin} ${currency}) at standard rate. Walk the ladder methodically.`,
      walk: `Margin marginal ($${expectedMargin} ${currency}). Be prepared to decline gracefully if shipper pushes hard.`,
    };

    return {
      approach,
      reasoning: reasoningMap[approach],
      keySellingPoints: [
        'vetted carriers with strong on-time records',
        'live GPS tracking visible on your screen from pickup to delivery',
        'digital proof of delivery within minutes of drop-off',
        'dedicated founder-led service — direct line to the broker, not a call center',
      ],
      potentialObjections: ['rate_too_high', 'already_have_carrier'],
      urgencyFactors: this.urgencyFor(load),
      rapportTopics: this.rapportFor(load),
    };
  }

  private urgencyFor(load: PipelineLoadRow): string[] {
    const factors: string[] = [];
    const pickup = load.pickup_date instanceof Date ? load.pickup_date : new Date(load.pickup_date);
    const hoursUntil = (pickup.getTime() - Date.now()) / 3600_000;
    if (hoursUntil < 48) factors.push(`Pickup in ${Math.round(hoursUntil)} hours — limited capacity`);
    if (load.origin_country !== load.destination_country)
      factors.push('Cross-border — fewer authorized carriers available');
    return factors;
  }

  private rapportFor(load: PipelineLoadRow): string[] {
    return [
      `Ask about facility conditions at the ${load.destination_city} delivery site`,
      `Mention familiarity with the ${load.origin_city} → ${load.destination_city} corridor`,
      'Ask about their typical weekly shipping volume on this lane',
    ];
  }

  private voiceSettingsFor(
    persona: string,
  ): NegotiationBrief['persona']['voiceSettings'] {
    switch (persona) {
      case 'assertive':
        return { speed: 1.05, temperature: 0.4, emotion: 'confident' };
      case 'analytical':
        return { speed: 0.95, temperature: 0.3, emotion: 'calm' };
      case 'friendly':
      default:
        return { speed: 1.0, temperature: 0.5, emotion: 'warm' };
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // PERSONA + COMPLIANCE + DATA FETCHES
  // ──────────────────────────────────────────────────────────────────────

  private async selectPersonaFromDb(): Promise<
    ReturnType<typeof selectPersona> & { retellAgentId: string }
  > {
    const result = await db.query<
      PersonaStats & { retell_agent_id_en: string | null; retell_agent_id_fr: string | null }
    >(
      `SELECT id, persona_name, alpha::numeric AS alpha, beta::numeric AS beta,
              total_calls, retell_agent_id_en, retell_agent_id_fr
       FROM personas
       WHERE is_active = true`,
    );

    if (result.rows.length === 0) {
      throw new Error('No active personas in database — cannot select');
    }

    const stats: PersonaStats[] = result.rows.map((r) => ({
      id: r.id,
      persona_name: r.persona_name,
      alpha: Number(r.alpha),
      beta: Number(r.beta),
      total_calls: r.total_calls,
    }));

    const winner = selectPersona(stats);
    const winnerRow = result.rows.find((r) => r.id === winner.persona_id);
    const retellAgentId = winnerRow?.retell_agent_id_en ?? '';
    if (!retellAgentId) {
      logger.warn(
        `[Compiler] Persona ${winner.persona_name} has no retell_agent_id_en configured`,
      );
    }
    return { ...winner, retellAgentId };
  }

  private async checkCompliance(load: PipelineLoadRow): Promise<NegotiationBrief['compliance']> {
    const phone = load.shipper_phone || '';
    let dncHit = false;
    if (phone) {
      const dnc = await db.query<{ id: number }>(
        `SELECT id FROM dnc_list WHERE phone = $1 LIMIT 1`,
        [phone],
      );
      dncHit = dnc.rows.length > 0;
    }

    const callingHoursOk = this.isWithinCallingHours();

    return {
      consentType: 'implied_load_post' as any,
      consentSource: this.normalizeBoardSource(load.load_board_source).toLowerCase(),
      consentTimestamp: new Date().toISOString(),
      callingHoursOk,
      callingWindowStart: '08:00',
      callingWindowEnd: '20:00',
      dncChecked: !dncHit,
      dncCheckTimestamp: new Date().toISOString(),
      recordingDisclosureRequired: false,
      disclosureScript: null,
      jurisdictionNotes:
        load.origin_country === 'CA'
          ? `${load.origin_state}, Canada — one-party consent province.`
          : `${load.origin_state}, USA — verify state recording laws.`,
    };
  }

  private async loadShipperHistory(phone: string | null): Promise<{
    previousCallCount: number;
    previousOutcomes: string[];
    isRepeatShipper: boolean;
    lastBookedRate: number | null;
    lastBookedDate: string | null;
    fatigueScore: number;
    knownObjections: string[];
    preferredLanguage: 'en' | 'fr';
    preferredCurrency: 'CAD' | 'USD';
    notes: string | null;
  }> {
    const fallback = {
      previousCallCount: 0,
      previousOutcomes: [],
      isRepeatShipper: false,
      lastBookedRate: null as number | null,
      lastBookedDate: null as string | null,
      fatigueScore: 0,
      knownObjections: [] as string[],
      preferredLanguage: 'en' as 'en' | 'fr',
      preferredCurrency: 'CAD' as 'CAD' | 'USD',
      notes: null as string | null,
    };
    if (!phone) return fallback;

    const pref = await db.query<{
      preferred_language: string | null;
      preferred_currency: string | null;
      total_calls_received: number | null;
      total_bookings: number | null;
      avg_agreed_rate: string | null;
      last_objection_type: string | null;
    }>(`SELECT * FROM shipper_preferences WHERE phone = $1 LIMIT 1`, [phone]);

    const calls = await db.query<{ outcome: string; agreed_rate: string | null; call_initiated_at: Date }>(
      `SELECT outcome, agreed_rate, call_initiated_at
       FROM agent_calls
       WHERE phone_number_called = $1
       ORDER BY call_initiated_at DESC
       LIMIT 10`,
      [phone],
    );

    const lastBooked = calls.rows.find((r) => r.outcome === 'booked' && r.agreed_rate);
    const recentCount = calls.rows.filter(
      (r) => new Date(r.call_initiated_at).getTime() > Date.now() - 7 * 86400_000,
    ).length;

    const p = pref.rows[0];
    return {
      previousCallCount: p?.total_calls_received ?? calls.rows.length,
      previousOutcomes: calls.rows.map((r) => r.outcome).filter(Boolean),
      isRepeatShipper: (p?.total_bookings ?? 0) > 0,
      lastBookedRate: lastBooked?.agreed_rate ? Number(lastBooked.agreed_rate) : null,
      lastBookedDate: lastBooked
        ? new Date(lastBooked.call_initiated_at).toISOString().split('T')[0]
        : null,
      fatigueScore: recentCount,
      knownObjections: p?.last_objection_type ? [p.last_objection_type] : [],
      preferredLanguage: ((p?.preferred_language as 'en' | 'fr') || 'en'),
      preferredCurrency: ((p?.preferred_currency as 'CAD' | 'USD') || 'CAD'),
      notes: null,
    };
  }

  private async fetchPipelineLoad(id: number): Promise<PipelineLoadRow | null> {
    const res = await db.query<PipelineLoadRow>(
      `SELECT * FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    return res.rows[0] || null;
  }

  private async fetchCarrierStack(loadId: string): Promise<NegotiationBrief['carriers']> {
    const res = await db.query<{
      carrier_id: string;
      match_score: string;
      match_grade: string;
      breakdown: any;
      company: string | null;
      contact_name: string | null;
      contact_phone: string | null;
      mc_number: string | null;
      authority_status: string | null;
      home_city: string | null;
    }>(
      `SELECT m.carrier_id, m.match_score, m.match_grade, m.breakdown,
              c.company, c.contact_name, c.contact_phone, c.mc_number,
              c.authority_status, c.home_city
       FROM match_results m
       LEFT JOIN carriers c ON c.id = m.carrier_id
       WHERE m.load_id = $1
       ORDER BY m.match_score DESC
       LIMIT 5`,
      [loadId],
    );

    return res.rows.map((r) => {
      const breakdown = r.breakdown ?? {};
      const carrierAvgRate = breakdown?.rate?.carrier_avg_rate ?? null;
      return {
        carrierId: r.carrier_id as any,
        companyName: r.company ?? 'Unknown',
        contactName: r.contact_name ?? '',
        contactPhone: r.contact_phone ?? '',
        mcNumber: r.mc_number ?? null,
        rate: carrierAvgRate ?? 0,
        matchScore: Math.round(Number(r.match_score) * 100),
        matchGrade: (r.match_grade as 'A' | 'B' | 'C' | 'D' | 'F') ?? 'C',
        availabilityConfidence: 'medium' as const,
        equipmentConfirmed: true,
        onTimePercentage: null,
        totalLoadsWithMyra: 0,
        paymentPreference: 'standard' as const,
        lastLoadDate: null,
        driverLanguage: null,
      };
    });
  }

  private async persistBrief(brief: NegotiationBrief): Promise<number> {
    const res = await db.query<{ id: number }>(
      `INSERT INTO negotiation_briefs (
         pipeline_load_id, brief, brief_version, persona_selected, strategy,
         initial_offer, target_rate, min_acceptable_rate,
         concession_step_1, concession_step_2, final_offer,
         carrier_count, top_carrier_id, top_carrier_rate, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       RETURNING id`,
      [
        brief.meta.pipelineLoadId,
        JSON.stringify(brief),
        brief.meta.briefVersion,
        brief.persona.personaName,
        brief.strategy.approach,
        brief.negotiation.initialOffer,
        brief.rates.totalCost + brief.rates.targetMargin,
        brief.negotiation.finalOffer,
        brief.negotiation.concessionStep1,
        brief.negotiation.concessionStep2,
        brief.negotiation.finalOffer,
        brief.carriers.length,
        brief.carriers[0]?.carrierId ?? null,
        brief.carriers[0]?.rate ?? null,
      ],
    );
    return res.rows[0].id;
  }

  protected async updatePipelineLoad(pipelineLoadId: number, result: ProcessResult): Promise<void> {
    await super.updatePipelineLoad(pipelineLoadId, result);

    const briefId = result.details?.briefId;
    if (briefId && this.callQueue) {
      await this.callQueue.add(
        'call',
        {
          pipelineLoadId,
          briefId,
          loadId: (result.details as any)?.brief?.load?.loadId ?? '',
          loadBoardSource: (result.details as any)?.brief?.load?.loadBoardSource ?? 'unknown',
          enqueuedAt: new Date().toISOString(),
          priority: (result.details as any)?.brief?.callConfig?.callPriority ?? 5,
          retellPayload: result.details?.retellPayload,
        },
        { priority: 5 },
      );
      logger.debug(`[Compiler] Brief ${briefId} enqueued to call-queue (Sprint 4 will dial)`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // FORMATTING HELPERS
  // ──────────────────────────────────────────────────────────────────────

  private normalizeEquipment(raw: string): NegotiationBrief['load']['equipmentType'] {
    const lower = (raw || '').toLowerCase();
    if (lower.includes('flat')) return 'flatbed';
    if (lower.includes('reefer') || lower.includes('refrigerated')) return 'reefer';
    if (lower.includes('step')) return 'step_deck';
    if (lower.includes('tanker')) return 'tanker';
    if (lower.includes('lowboy')) return 'lowboy';
    if (lower.includes('container')) return 'container';
    return 'dry_van';
  }

  private equipmentDisplayName(raw: string): string {
    const norm = this.normalizeEquipment(raw);
    const map: Record<string, string> = {
      dry_van: 'dry van',
      flatbed: 'flatbed',
      reefer: 'reefer',
      step_deck: 'step deck',
      tanker: 'tanker',
      lowboy: 'lowboy',
      container: 'container',
      van: 'van',
    };
    return map[norm] ?? 'dry van';
  }

  private normalizeBoardSource(raw: string | null): NegotiationBrief['load']['loadBoardSource'] {
    const lower = (raw || '').toLowerCase();
    if (lower.includes('dat')) return 'DAT';
    if (lower.includes('truckstop')) return 'Truckstop';
    if (lower.includes('123')) return '123LB';
    if (lower.includes('loadlink')) return 'Loadlink';
    if (lower === 'csv' || lower === 'manual') return 'manual';
    return 'manual';
  }

  private formatDateLong(d: Date): string {
    const day = d.toLocaleDateString('en-US', { weekday: 'long' });
    const month = d.toLocaleDateString('en-US', { month: 'long' });
    const date = d.getDate();
    const suffix = this.ordinalSuffix(date);
    return `${day} ${month} ${date}${suffix}`;
  }

  private ordinalSuffix(n: number): string {
    if (n >= 11 && n <= 13) return 'th';
    switch (n % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  }

  private formatPhoneDisplay(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
      return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return phone;
  }

  private formatCurrencyDisplay(amount: number, currency: 'CAD' | 'USD'): string {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  }

  private isWithinCallingHours(): boolean {
    const hour = new Date().getHours();
    return hour >= 8 && hour < 20;
  }

  private timezoneForState(_phone: string, state: string): string {
    const easternStates = new Set(['ON', 'QC', 'NY', 'NJ', 'PA', 'CT', 'MA', 'NH', 'VT', 'ME', 'RI', 'NB', 'NS', 'PE']);
    const centralStates = new Set(['MB', 'TX', 'IL', 'MN', 'WI', 'MO', 'IA', 'AR', 'OK', 'KS', 'NE']);
    const mountainStates = new Set(['AB', 'SK', 'CO', 'AZ', 'UT', 'NM', 'WY', 'MT', 'ID']);
    const pacificStates = new Set(['BC', 'CA', 'OR', 'WA', 'NV']);
    if (easternStates.has(state)) return 'America/Toronto';
    if (centralStates.has(state)) return 'America/Chicago';
    if (mountainStates.has(state)) return 'America/Denver';
    if (pacificStates.has(state)) return 'America/Los_Angeles';
    return 'America/Toronto';
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

export type CompiledOutput = {
  brief: NegotiationBrief;
  retellPayload: RetellCreatePhoneCallPayload;
  briefId: number;
};
