//
// Verbatim behavioral port of compiler-worker.ts's loadShipperHistory()
// (531-595) and the shipper section of assembleBrief() (278-296), plus
// buildStrategy()/urgencyFor()/rapportFor() (394-440) — under the
// generalized Counterparty/NegotiationBriefStrategy shape. Required so
// sell-side shadow parity (Task 8) actually holds field-for-field; NOT an
// import from compiler-worker.ts, which is off-limits (Global Constraints).

import { db } from '@/lib/pipeline/db-adapter';
import { formatPhoneDisplay } from './format-helpers';
import type { Counterparty, NegotiationBriefStrategy } from './types';

interface ShipperLoadFields {
  shipper_phone: string | null;
  shipper_company: string | null;
  shipper_contact_name: string | null;
  shipper_email: string | null;
}

export async function profileShipper(load: ShipperLoadFields): Promise<Counterparty> {
  const phone = load.shipper_phone;
  const base: Counterparty = {
    counterpartyType: 'shipper',
    companyName: load.shipper_company,
    contactName: load.shipper_contact_name,
    phone: phone || '',
    phoneFormatted: formatPhoneDisplay(phone || ''),
    email: load.shipper_email,
    preferredLanguage: 'en',
    previousCallCount: 0,
    previousOutcomes: [],
    isRepeat: false,
    mcNumber: null,
    myraCarrierScore: null,
  };
  if (!phone) return base;

  const pref = await db.query<{
    preferred_language: string | null; preferred_currency: string | null;
    total_calls_received: number | null; total_bookings: number | null;
    avg_agreed_rate: string | null; last_objection_type: string | null;
  }>(`SELECT * FROM shipper_preferences WHERE phone = $1 LIMIT 1`, [phone]);

  const calls = await db.query<{ outcome: string; agreed_rate: string | null; call_initiated_at: Date }>(
    `SELECT outcome, agreed_rate, call_initiated_at
       FROM agent_calls
      WHERE phone_number_called = $1
      ORDER BY call_initiated_at DESC
      LIMIT 10`,
    [phone],
  );

  const p = pref.rows[0];
  return {
    ...base,
    preferredLanguage: (p?.preferred_language as 'en' | 'fr') || 'en',
    previousCallCount: p?.total_calls_received ?? calls.rows.length,
    previousOutcomes: calls.rows.map((r) => r.outcome).filter(Boolean),
    isRepeat: (p?.total_bookings ?? 0) > 0,
  };
}

export function determineSellStrategy(
  approach: 'aggressive' | 'standard' | 'walk',
  negotiation: { initialOffer: number },
  totalCost: number,
  currency: 'CAD' | 'USD',
  load: { pickup_date: Date | string; origin_country: string; destination_country: string; origin_city: string; destination_city: string },
): NegotiationBriefStrategy {
  const expectedMargin = negotiation.initialOffer - totalCost;
  const reasoningMap: Record<typeof approach, string> = {
    aggressive: `Strong margin opportunity ($${expectedMargin} ${currency}) — push to stretch.`,
    standard: `Healthy margin ($${expectedMargin} ${currency}) at standard rate. Walk the ladder methodically.`,
    walk: `Margin marginal ($${expectedMargin} ${currency}). Be prepared to decline gracefully if shipper pushes hard.`,
  };

  const pickup = load.pickup_date instanceof Date ? load.pickup_date : new Date(load.pickup_date);
  const hoursUntil = (pickup.getTime() - Date.now()) / 3600_000;
  const urgencyFactors: string[] = [];
  if (hoursUntil < 48) urgencyFactors.push(`Pickup in ${Math.round(hoursUntil)} hours — limited capacity`);
  if (load.origin_country !== load.destination_country) urgencyFactors.push('Cross-border — fewer authorized carriers available');

  const talkingPoints = [
    'vetted carriers with strong on-time records',
    'live GPS tracking visible on your screen from pickup to delivery',
    'digital proof of delivery within minutes of drop-off',
    'dedicated founder-led service — direct line to the broker, not a call center',
    ...urgencyFactors,
    `Ask about facility conditions at the ${load.destination_city} delivery site`,
    `Mention familiarity with the ${load.origin_city} -> ${load.destination_city} corridor`,
  ];

  return { approach, reasoning: reasoningMap[approach], keyTalkingPoints: talkingPoints };
}
