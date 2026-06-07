/**
 * Single source of truth for "what hour is it for this party" decisions.
 *
 * NEVER use `new Date().getHours()` / `.getDay()` for time-of-day logic: worker
 * containers (Railway) and serverless functions run in **UTC**, so those return
 * the server's hour, not the contact's. Always render "now" into the target IANA
 * timezone with `Intl`.
 *
 * This module exists because the calling-hours check was implemented three times
 * (Compiler, Voice, ComplianceService) and the Compiler's private copy used the
 * server clock — in production (UTC) it rejected every valid daytime call. Sharing
 * one implementation prevents that drift from recurring. Map a shipper's province/
 * state to an IANA zone with the worker's `timezoneForState()` before calling these.
 */

/** Hour (0–23) at `at` in the given IANA timezone. Falls back to the UTC hour. */
export function hourInZone(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone,
    }).formatToParts(at);
    const h = parts.find((p) => p.type === 'hour')?.value;
    const n = h ? parseInt(h, 10) : at.getUTCHours();
    return n === 24 ? 0 : n; // some locales render midnight as "24"
  } catch {
    return at.getUTCHours();
  }
}

/**
 * True if `at` falls within [startHour, endHour) in the contact's timezone.
 * Default window 08:00–20:00 matches the Voice worker's dial-time recheck and the
 * Compiler's brief-validation gate.
 */
export function isWithinCallingHours(
  timeZone: string,
  startHour = 8,
  endHour = 20,
  at: Date = new Date(),
): boolean {
  const h = hourInZone(timeZone, at);
  return h >= startHour && h < endHour;
}
