/**
 * AGENT 5 - BRIEF COMPILER WORKER
 *
 * Produces the negotiation brief - a complete, self-contained JSON document
 * that Agent 6 receives before making a call. Merges output from Agent 3
 * (Researcher) and Agent 4 (Carrier Ranker), adds persona selection (Thompson
 * Sampling), objection playbook, and compliance checks.
 *
 * Input: brief-queue with BriefJobPayload (after both Agent 3 and 4 complete)
 * Output: negotiation_briefs table row created, enqueued to call-queue
 * Next Stage: briefed → calling (when voice agent initiates call)
 *
 * This agent does NO AI and NO COMPUTATION beyond template merging.
 * It's the fastest agent in the pipeline - target < 100ms per brief.
 */

import { Job } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Brief job payload - received from completion gate (after Agents 3 and 4)
 */
export interface BriefJobPayload extends BaseJobPayload {
  researchResult: {
    marketRateFloor: number;
    marketRateMid: number;
    marketRateBest: number;
    totalCost: number;
    marginEnvelope: {
      floor: number;
      target: number;
      stretch: number;
    };
    recommendedStrategy: 'aggressive' | 'standard' | 'walk';
    shipperProfile: {
      postingFrequency: number;
      historicalRates: number[];
      preferredLanguage: string;
    };
  };
  carrierStack: Array<{
    carrierId: number;
    companyName: string;
    contactPhone: string;
    rate: number;
    matchScore: number;
    availabilityConfidence: 'high' | 'medium' | 'low';
    equipmentConfirmed: boolean;
  }>;
}

/**
 * Complete negotiation brief schema
 */
interface NegotiationBrief {
  meta: {
    briefId: number;
    briefVersion: string;
    pipelineLoadId: number;
    generatedAt: string;
    generatedBy: string;
  };
  load: {
    loadId: string;
    loadBoardSource: string;
    origin: { city: string; state: string; country: string };
    destination: { city: string; state: string; country: string };
    pickupDate: string;
    pickupTime: string | null;
    deliveryDate: string | null;
    deliveryTime: string | null;
    equipmentType: string;
    commodity: string | null;
    weightLbs: number | null;
    distanceMiles: number;
    distanceKm: number;
    crossBorder: boolean;
    specialRequirements: string | null;
  };
  shipper: {
    companyName: string | null;
    contactName: string | null;
    phone: string;
    email: string | null;
    preferredLanguage: string;
    preferredCurrency: string;
    previousCallCount: number;
    previousOutcomes: string[];
    fatigueScore: number;
    isRepeatShipper: boolean;
    lastBookedRate: number | null;
  };
  rates: {
    marketRateFloor: number;
    marketRateMid: number;
    marketRateBest: number;
    rateConfidence: number;
    rateSources: string[];
    totalCost: number;
    costBreakdown: any;
    currency: string;
    minMargin: number;
    targetMargin: number;
    stretchMargin: number;
  };
  negotiation: {
    initialOffer: number;
    concessionStep1: number;
    concessionStep2: number;
    finalOffer: number;
    maxConcessions: number;
    concessionAsks: string[];
    walkAwayRate: number;
    walkAwayScript: string;
  };
  strategy: {
    approach: 'aggressive' | 'standard' | 'walk';
    reasoning: string;
    keySellingPoints: string[];
    potentialObjections: string[];
  };
  carriers: any[];
  persona: {
    personaName: string;
    retellAgentId: string;
    selectionMethod: string;
    selectionScore: number;
  };
  objectionPlaybook: Array<{
    objectionType: string;
    response: string;
    followUpQuestion: string;
    escalateAfter: number;
  }>;
  compliance: {
    consentType: string;
    consentSource: string;
    callingHoursOk: boolean;
    dncChecked: boolean;
    recordingDisclosureRequired: boolean;
    disclosureScript: string | null;
  };
  callConfig: {
    maxDurationSeconds: number;
    language: string;
    timezone: string;
    retellWebhookUrl: string;
    callbackOnNoAnswer: boolean;
    maxCallAttempts: number;
  };
}

/**
 * Compiler worker - brief assembly
 */
export class CompilerWorker extends BaseWorker<BriefJobPayload> {
  private callQueue: any; // TODO: Import Queue type

  constructor(redis: Redis, callQueue: any) {
    const config: WorkerConfig = {
      queueName: 'brief-queue',
      expectedStage: 'matched',
      nextStage: 'briefed',
      concurrency: 20, // Pure template logic, very fast
      retryConfig: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 30000, // 30 seconds
        },
      },
      redis,
    };

    super(config);
    this.callQueue = callQueue;
  }

  /**
   * Main brief compilation logic
   */
  public async process(payload: BriefJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;
    logger.debug(`[Compiler] Compiling brief for load ${pipelineLoadId}`);

    try {
      // Fetch full load data from database
      const loadResult = await db.query('SELECT * FROM pipeline_loads WHERE id = $1', [pipelineLoadId]);
      const load = loadResult.rows[0];

      if (!load) {
        throw new Error(`Load ${pipelineLoadId} not found`);
      }

      // TODO: Implement the 8-step brief compilation
      // 1. Load data (copy from pipeline_loads - no transformation)
      // 2. Shipper profile (query shipper_preferences + agent_calls history)
      // 3. Rate envelope (compute from Agent 3 output)
      // 4. Strategy selection (already provided by Agent 3)
      // 5. Persona selection (Thompson Sampling)
      // 6. Objection playbook (static lookup + personalization)
      // 7. Compliance check (consent, DNC, calling hours)
      // 8. Assemble and store

      // Placeholder brief compilation
      const brief: NegotiationBrief = {
        meta: {
          briefId: 0, // Will be set from DB insert
          briefVersion: '1.0',
          pipelineLoadId,
          generatedAt: new Date().toISOString(),
          generatedBy: 'compiler-v1',
        },
        load: {
          loadId: load.load_id,
          loadBoardSource: load.load_board_source,
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
          pickupDate: load.pickup_date,
          pickupTime: null,
          deliveryDate: load.delivery_date,
          deliveryTime: null,
          equipmentType: load.equipment_type,
          commodity: load.commodity,
          weightLbs: load.weight_lbs,
          distanceMiles: load.distance_miles,
          distanceKm: load.distance_km,
          crossBorder: load.origin_country !== load.destination_country,
          specialRequirements: null,
        },
        shipper: {
          companyName: load.shipper_company,
          contactName: load.shipper_contact_name,
          phone: load.shipper_phone,
          email: load.shipper_email,
          preferredLanguage: 'en', // TODO: Look up from shipper_preferences
          preferredCurrency: load.posted_rate_currency,
          previousCallCount: 0, // TODO: Count from agent_calls
          previousOutcomes: [], // TODO: Query from agent_calls
          fatigueScore: 0, // TODO: Compute from call outcomes
          isRepeatShipper: false, // TODO: Check shipper history
          lastBookedRate: null, // TODO: Query from agent_calls
        },
        rates: {
          marketRateFloor: load.market_rate_floor || 0,
          marketRateMid: load.market_rate_mid || 0,
          marketRateBest: load.market_rate_best || 0,
          rateConfidence: 0.5, // TODO: From research result
          rateSources: [], // TODO: From research result
          totalCost: 0, // TODO: From research result
          costBreakdown: {}, // TODO: From research result
          currency: load.posted_rate_currency,
          minMargin: 270,
          targetMargin: 470,
          stretchMargin: 675,
        },
        negotiation: {
          initialOffer: 0, // TODO: Compute from rates + margins
          concessionStep1: 0,
          concessionStep2: 0,
          finalOffer: 0,
          maxConcessions: 3,
          concessionAsks: [
            'flexibility on pickup appointment',
            'commitment to future loads',
            'extended delivery window',
          ],
          walkAwayRate: 0, // TODO: Compute
          walkAwayScript:
            "I can't make the numbers work at that rate, but I'd love to help with your next load.",
        },
        strategy: {
          approach: (load.recommended_strategy as any) || 'standard',
          reasoning: 'Standard negotiation approach',
          keySellingPoints: [
            'vetted carriers with local experience',
            'live GPS tracking visible on your screen',
            'digital proof of delivery within minutes',
            'dedicated founder-led service',
          ],
          potentialObjections: ['rate_too_high', 'have_broker'],
        },
        carriers: payload.carrierStack.map((c) => ({
          carrierId: c.carrierId,
          companyName: c.companyName,
          contactPhone: c.contactPhone,
          rate: c.rate,
          matchScore: c.matchScore,
          availabilityConfidence: c.availabilityConfidence,
          equipmentConfirmed: c.equipmentConfirmed,
        })),
        persona: {
          personaName: 'friendly', // TODO: Thompson Sampling selection
          retellAgentId: 'agent_friendly_en_001',
          selectionMethod: 'thompson_sampling',
          selectionScore: 0.5,
        },
        objectionPlaybook: [
          {
            objectionType: 'rate_too_high',
            response:
              'I understand that price is important. We focus on reliable service. Can we work together on this rate?',
            followUpQuestion: 'What rate would work for you?',
            escalateAfter: 0,
          },
          {
            objectionType: 'have_broker',
            response:
              "That's great. We'd love to be a backup option. There will come a time when your go-to is unavailable.",
            followUpQuestion: 'What lanes does your current broker cover?',
            escalateAfter: 0,
          },
        ],
        compliance: {
          consentType: 'implied_load_post',
          consentSource: load.load_board_source.toLowerCase(),
          callingHoursOk: true, // TODO: Check timezone
          dncChecked: true, // TODO: Verify against dnc_list
          recordingDisclosureRequired: false,
          disclosureScript: null,
        },
        callConfig: {
          maxDurationSeconds: 300,
          language: 'en',
          timezone: 'America/Toronto', // TODO: Infer from shipper location
          retellWebhookUrl: 'https://myratms.vercel.app/api/webhooks/retell-callback',
          callbackOnNoAnswer: true,
          maxCallAttempts: 2,
        },
      };

      // TODO: Validate brief before storing
      // await this.validateBrief(brief);

      // Store brief in database
      const briefId = await this.storeBrief(brief);
      brief.meta.briefId = briefId;

      logger.info(
        `[Compiler] Brief ${briefId} compiled for load ${pipelineLoadId}. Strategy: ${brief.strategy.approach}. Persona: ${brief.persona.personaName}`
      );

      // TODO: Enqueue to call-queue
      // const callPayload = {
      //   pipelineLoadId,
      //   briefId,
      //   brief,
      //   retellAgentId: brief.persona.retellAgentId,
      //   phoneNumber: brief.shipper.phone,
      //   language: brief.callConfig.language,
      // };
      // await this.callQueue.add('call', callPayload, { priority: ... });

      return {
        success: true,
        pipelineLoadId,
        stage: this.config.expectedStage,
        duration: 0,
        details: {
          briefId,
          strategy: brief.strategy.approach,
          persona: brief.persona.personaName,
          carriers: brief.carriers.length,
        },
      };
    } catch (error) {
      logger.error(`[Compiler] Error compiling brief for load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Store the compiled brief in the database
   */
  private async storeBrief(brief: NegotiationBrief): Promise<number> {
    try {
      const result = await db.query(
        `INSERT INTO negotiation_briefs (
          pipeline_load_id, brief, brief_version, persona_selected, strategy,
          initial_offer, target_rate, min_acceptable_rate,
          concession_step_1, concession_step_2, final_offer,
          carrier_count, top_carrier_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
        RETURNING id`,
        [
          brief.meta.pipelineLoadId,
          JSON.stringify(brief),
          brief.meta.briefVersion,
          brief.persona.personaName,
          brief.strategy.approach,
          brief.negotiation.initialOffer,
          0, // target_rate - TODO
          brief.negotiation.finalOffer,
          brief.negotiation.concessionStep1,
          brief.negotiation.concessionStep2,
          brief.negotiation.finalOffer,
          brief.carriers.length,
          brief.carriers[0]?.carrierId || null,
        ]
      );

      return result.rows[0].id;
    } catch (error) {
      logger.error('Failed to store brief:', error);
      throw error;
    }
  }

  /**
   * Validate brief before storing
   */
  private async validateBrief(brief: NegotiationBrief): Promise<void> {
    // TODO: Implement validation rules from T-08 Section 4
    // Rules:
    // - Rate sanity: initialOffer > finalOffer > 0
    // - Carrier exists: carriers array has >= 1 entry
    // - Phone valid: E.164 or 10-digit format
    // - Consent valid: consentType is not null
    // - DNC clear: dncChecked is true
    // - Calling hours: callingHoursOk is true
    // - Fatigue check: fatigueScore < 3
    // - Not expired: pickupDate > now + 4 hours
    // - Currency match: rates.currency matches shipper.preferredCurrency

    if (brief.negotiation.initialOffer <= brief.negotiation.finalOffer) {
      throw new Error('Rate sanity check failed: initialOffer must be > finalOffer');
    }

    if (brief.carriers.length === 0) {
      throw new Error('Brief validation failed: no carriers in stack');
    }

    if (!brief.shipper.phone) {
      throw new Error('Brief validation failed: no shipper phone');
    }

    if (!brief.compliance.consentType) {
      throw new Error('Brief validation failed: no consent type (compliance block)');
    }

    if (!brief.compliance.dncChecked) {
      throw new Error('Brief validation failed: DNC not checked (compliance block)');
    }
  }
}

// TODO: Export initialized worker
// export const compilerWorker = new CompilerWorker(redisClient, callQueue);

// TODO: Implement Thompson Sampling persona selection
// function selectPersonaThompsonSampling(personas: Persona[]): string {
//   // For each persona:
//   //   alpha = persona.total_bookings + 1
//   //   beta = (persona.total_calls - persona.total_bookings) + 1
//   //   sample = random draw from Beta(alpha, beta)
//   // Select persona with highest sample
// }
