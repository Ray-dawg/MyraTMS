import { db } from '@/lib/pipeline/db-adapter';
import { formatPhoneDisplay } from './format-helpers';
import type { Counterparty } from './types';

interface CarrierRow {
  id: string;
  company: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  mc_number: string | null;
}

export async function profileCarrier(carrierRegistryId: number): Promise<Counterparty> {
  const carrierRes = await db.query<CarrierRow>(
    `SELECT id, company, contact_name, contact_phone, contact_email, mc_number
       FROM carriers
      WHERE carrier_registry_id = $1
      LIMIT 1`,
    [carrierRegistryId],
  );
  const carrier = carrierRes.rows[0];

  const scoreRes = await db.query<{ score: string | null }>(
    `SELECT score FROM myra_carrier_scores
      WHERE carrier_registry_id = $1
      ORDER BY computed_at DESC
      LIMIT 1`,
    [carrierRegistryId],
  );
  // Confirmed live: 211/211 myra_carrier_scores rows currently have score=NULL
  // (total_loads_observed < 5, the T-20 threshold). Passing null through
  // explicitly rather than defaulting to 0 — a 0 score would read as "worst
  // possible carrier" to anything downstream, which is false; "unscored" and
  // "scored zero" are different facts.
  const myraCarrierScore = scoreRes.rows[0]?.score != null ? Number(scoreRes.rows[0].score) : null;

  const outcomesRes = await db.query<{ event_type: string }>(
    `SELECT event_type FROM carrier_outcome_events
      WHERE carrier_registry_id = $1
      ORDER BY occurred_at DESC
      LIMIT 10`,
    [carrierRegistryId],
  );

  const phone = carrier?.contact_phone ?? '';
  return {
    counterpartyType: 'carrier',
    companyName: carrier?.company ?? null,
    contactName: carrier?.contact_name ?? null,
    phone,
    phoneFormatted: formatPhoneDisplay(phone),
    email: carrier?.contact_email ?? null,
    preferredLanguage: 'en',
    previousCallCount: outcomesRes.rows.length,
    previousOutcomes: outcomesRes.rows.map((r) => r.event_type),
    isRepeat: outcomesRes.rows.some((r) => r.event_type === 'accepted'),
    mcNumber: carrier?.mc_number ?? null,
    myraCarrierScore,
  };
}
