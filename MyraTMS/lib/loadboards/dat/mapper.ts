/**
 * DAT API response → RawLoad mapper.
 *
 * STUB until DAT credentials are provisioned and we know the actual
 * response shape. Tooltip for the future implementer:
 *
 *   The DAT Power API returns loads roughly shaped:
 *     { matchId, origin: { city, state, lat, lng }, destination: {...},
 *       equipment: 'V'|'F'|'R'|..., pickupDate, weight, length,
 *       rate: { amount, type }, broker: { name, phone, email }, ... }
 *
 *   Use the helpers in ../normalize-helpers.ts:
 *     parseCityState, inferCountry, normalizeEquipment, parseWeight,
 *     parseDate, parseRate, inferRateType, normalizePhone
 *
 *   The output RawLoad MUST match the shape used by
 *   MyraTMS/lib/workers/scanner-worker.ts.
 */

import type { RawLoad } from '@/lib/workers/scanner-worker';

export function mapDATToRawLoad(_apiRow: unknown): RawLoad | null {
  // TODO when DAT credentials arrive:
  //   - Type apiRow as the actual DAT API response shape (not unknown)
  //   - Extract loadId, origin, destination, equipment, pickup, weight, rate, broker
  //   - Apply normalize helpers
  //   - Return null on any required field missing
  return null;
}
