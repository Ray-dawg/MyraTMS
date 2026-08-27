// lib/negotiation/index.ts
//
// T-22 §5 — compileEnvelope(). One function, both directions. Calls T-21's
// quotePricing() for the negotiation envelope, then assembles the rest
// (counterparty, objections, persona, strategy) via the direction-specific
// helpers in this module. Does NOT call or modify compiler-worker.ts,
// voice-worker.ts, carrier-voice-worker.ts, carrier-brief-compiler-worker.ts,
// retell-webhook.ts, or queues.ts (Global Constraints) -- this is a parallel
// service, not a cutover. T-22b (deferred) is what points those workers at
// this function later.

import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { isWithinCallingHours } from '@/lib/pipeline/time';
import { quotePricing } from '@/lib/pricing/pricing-engine';
import { calculateCarrierNegotiationParams } from '@/lib/pipeline/cost-calculator';
import { getObjectionPlaybook } from './objection-playbook';
import { selectPersonaForDirection } from './persona';
import { profileCarrier } from './profile-carrier';
import { profileShipper, determineSellStrategy } from './sell-brief';
import { determineBuyStrategy } from './buy-brief';
import { formatDateLong, normalizeEquipment, equipmentDisplayName, timezoneForState } from './format-helpers';
import type { NegotiationBrief, NegotiationBriefStrategy } from './types';

interface PipelineLoadRow {
  id: number; load_id: string;
  origin_city: string; origin_state: string; origin_country: string;
  destination_city: string; destination_state: string; destination_country: string;
  pickup_date: Date | string; delivery_date: Date | string | null;
  equipment_type: string; commodity: string | null; weight_lbs: number | null;
  distance_miles: number | null; distance_km: number | null;
  shipper_phone: string | null; shipper_company: string | null; shipper_contact_name: string | null; shipper_email: string | null;
  posted_rate: string | number | null;
  // Sole source for buy-side carrier-envelope math from migration 046
  // onward -- see the note at its call site below.
  confirmed_rate: string | number | null;
  recommended_strategy: string | null;
}

async function fetchPipelineLoad(id: number): Promise<PipelineLoadRow> {
  const { rows } = await db.query<PipelineLoadRow>(`SELECT * FROM pipeline_loads WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error(`pipeline_loads ${id} not found`);
  return rows[0];
}

async function checkDnc(phone: string): Promise<boolean> {
  if (!phone) return false;
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM dnc_list WHERE phone = $1 LIMIT 1`, [phone]);
  return rows.length > 0;
}

export async function compileEnvelope(input: {
  tenantId: number;
  direction: 'sell' | 'buy';
  pipelineLoadId: number;
  counterpartyId: number; // shipper direction: unused (shipper is load-keyed); buy direction: carrier_registry_id
}): Promise<NegotiationBrief> {
  const load = await fetchPipelineLoad(input.pipelineLoadId);
  const distanceMiles = Number(load.distance_miles ?? 0);
  const distanceKm = Number(load.distance_km ?? Math.round(distanceMiles * 1.60934));

  const pricingResult = await quotePricing({
    tenantId: input.tenantId,
    direction: input.direction,
    requestSource: input.direction === 'sell' ? 'engine2_researcher_shadow' : 'dispatch_one',
    pipelineLoadId: input.pipelineLoadId,
    load: {
      originCity: load.origin_city, originState: load.origin_state, originCountry: load.origin_country,
      destinationCity: load.destination_city, destinationState: load.destination_state, destinationCountry: load.destination_country,
      equipmentType: load.equipment_type,
      postedRate: load.posted_rate != null ? Number(load.posted_rate) : null,
      distanceMiles, distanceKm,
    },
  });

  const currency = pricingResult.negotiation.currency;

  const counterparty = input.direction === 'sell'
    ? await profileShipper(load)
    : await profileCarrier(input.counterpartyId);

  const counterpartyType: 'shipper' | 'carrier' = input.direction === 'sell' ? 'shipper' : 'carrier';
  const objections = await getObjectionPlaybook(counterpartyType, []);

  const persona = await selectPersonaForDirection(input.direction);

  const strategyLoadFields = {
    pickup_date: load.pickup_date, origin_country: load.origin_country, destination_country: load.destination_country,
    origin_city: load.origin_city, destination_city: load.destination_city,
  };

  let strategy: NegotiationBriefStrategy;
  if (input.direction === 'sell') {
    // Mirrors compiler-worker.ts's real call site: approach comes from the
    // load's recommended_strategy (Agent 3/Researcher), defaulting to
    // 'standard' when unset -- not a hardcoded 'standard'.
    const approach = (load.recommended_strategy as 'aggressive' | 'standard' | 'walk' | null) ?? 'standard';
    strategy = determineSellStrategy(
      approach,
      { initialOffer: pricingResult.negotiation.openingOffer },
      pricingResult.cost.total,
      currency,
      strategyLoadFields,
    );
  } else {
    // Buy-side envelope is recomputed from the shipper's confirmed rate via
    // calculateCarrierNegotiationParams() -- same source of truth
    // retell-webhook.ts's carrier-call processing uses, so the number this
    // brief shows is the same number live enforcement checks against, even
    // though this brief is not wired to that live path yet. Per migration
    // 046, confirmed_rate is the sole source for this math from M3 onward
    // -- agreed_rate is deliberately not used as a fallback here.
    if (load.confirmed_rate == null) {
      logger.warn(
        `[negotiation] pipeline_loads ${load.id} has no confirmed_rate -- buy-side envelope computed from $0`,
      );
    }
    const agreedShipperRate = Number(load.confirmed_rate ?? 0);
    const carrierEnvelope = calculateCarrierNegotiationParams(agreedShipperRate, currency);
    strategy = determineBuyStrategy(carrierEnvelope, counterparty.myraCarrierScore, strategyLoadFields);
  }

  const pickupDate = load.pickup_date instanceof Date ? load.pickup_date : new Date(load.pickup_date);
  const deliveryDate = load.delivery_date
    ? (load.delivery_date instanceof Date ? load.delivery_date : new Date(load.delivery_date))
    : null;
  const isCrossBorder = load.origin_country !== load.destination_country;
  // Known limitation: timezoneForState() always uses the shipper's origin
  // state, even on the buy path where the call is actually placed to the
  // carrier. A correct buy-side timezone would need a carrier location/state
  // field -- `carriers` currently has home_city/home_lat/home_lng but no
  // state/province column, and inventing one (or a geocoding lookup) is out
  // of scope for this task. This only affects the *displayed* calling-window
  // timezone/compliance block, not the negotiation math itself.
  const timezone = timezoneForState(load.shipper_phone || '', load.origin_state);
  // DNC must be checked against whoever is actually being called: the
  // shipper on the sell path, the carrier on the buy path.
  // counterparty.phone is populated by both profileShipper() and
  // profileCarrier(), so this is direction-agnostic -- unlike
  // load.shipper_phone, which is only ever the shipper's number.
  const dncHit = await checkDnc(counterparty.phone || '');

  return {
    meta: { briefId: 0, direction: input.direction, pipelineLoadId: load.id, tenantId: input.tenantId, generatedAt: new Date().toISOString() },
    load: {
      loadId: load.load_id,
      origin: { city: load.origin_city, state: load.origin_state, country: load.origin_country },
      destination: { city: load.destination_city, state: load.destination_state, country: load.destination_country },
      pickupDate: pickupDate.toISOString().split('T')[0],
      pickupDateFormatted: formatDateLong(pickupDate),
      deliveryDate: deliveryDate ? deliveryDate.toISOString().split('T')[0] : null,
      deliveryDateFormatted: deliveryDate ? formatDateLong(deliveryDate) : null,
      equipmentType: normalizeEquipment(load.equipment_type),
      equipmentTypeDisplay: equipmentDisplayName(load.equipment_type),
      commodity: load.commodity,
      weightLbs: load.weight_lbs,
      distanceMiles, distanceKm, crossBorder: isCrossBorder,
    },
    counterparty,
    pricing: pricingResult.negotiation,
    strategy,
    objectionPlaybook: objections,
    persona: {
      personaName: persona.personaName,
      retellAgentId: persona.retellAgentId,
      selectionMethod: 'thompson_sampling',
      selectionScore: persona.sampledValue,
    },
    compliance: {
      consentType: input.direction === 'sell' ? 'implied_load_post' : 'business_to_business',
      callingHoursOk: isWithinCallingHours(timezone),
      callingWindowStart: '08:00',
      callingWindowEnd: '20:00',
      dncChecked: !dncHit,
      jurisdictionNotes: load.origin_country === 'CA'
        ? `${load.origin_state}, Canada -- one-party consent province.`
        : `${load.origin_state}, USA -- verify state recording laws.`,
    },
    callConfig: { maxDurationSeconds: 300, language: counterparty.preferredLanguage, timezone, maxCallAttempts: 2 },
  };
}
