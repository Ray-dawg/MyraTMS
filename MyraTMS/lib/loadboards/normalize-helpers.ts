/**
 * Shared parsing helpers for load board API mappers.
 *
 * Adapted from scraper/src/pipeline/normalize.ts. The duplication is
 * intentional and temporary — when the headless scraper is retired, this
 * file becomes the canonical implementation and the scraper copy is
 * deleted with it. Don't extract a shared package; the shelf life of the
 * scraper doesn't justify the monorepo tooling cost.
 *
 * All functions are pure and synchronous so they're trivially testable.
 */

const CA_PROVINCES = new Set([
  'ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU',
]);

/**
 * "Sudbury, ON" → ["Sudbury", "ON"]
 * "Atlanta"     → ["Atlanta", ""]
 *
 * Truncates the second segment to 2 chars (boards sometimes return
 * "Ontario, CA" instead of "Sudbury, ON" — defend against that).
 */
export function parseCityState(s: string): [string, string] {
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length >= 2 && parts[1]) {
    return [parts[0], parts[1].slice(0, 2).toUpperCase()];
  }
  return [s.trim(), ''];
}

/**
 * NB: 'CA' as a state code means California, NOT Canada. Defending
 * against the "treat country code as state code" mistake — see test.
 */
export function inferCountry(state: string): 'CA' | 'US' {
  if (!state) return 'US';
  return CA_PROVINCES.has(state.toUpperCase()) ? 'CA' : 'US';
}

/**
 * Map free-text equipment labels to canonical Engine 2 values. Boards
 * use wildly different labels ("Vans, Dry" / "Dry Van" / "DV" / "V") so
 * we sniff for substrings instead of exact-matching.
 */
export function normalizeEquipment(s: string | null | undefined): string {
  if (!s) return 'dry_van';
  const lower = s.toLowerCase();
  if (lower.includes('reefer') || lower.includes('refriger')) return 'reefer';
  if (lower.includes('flat')) return 'flatbed';
  if (lower.includes('step')) return 'step_deck';
  if (lower.includes('tank')) return 'tanker';
  if (lower.includes('van') || lower.includes('dry')) return 'dry_van';
  return 'dry_van';
}

/**
 * Strip thousand-separators, extract the leading integer.
 * "42,000" → 42000   "38500 lbs" → 38500   "" → null
 */
export function parseWeight(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Permissive date parser — handles ISO, Date.parse-able strings, plus
 * "Today" / "Tomorrow" which DAT-style sources use. Falls back to today
 * (better to ingest with wrong date than skip the row).
 */
export function parseDate(s: string | null | undefined): string {
  if (!s) return new Date().toISOString();
  const trimmed = s.trim();
  if (/^today$/i.test(trimmed)) return new Date().toISOString();
  if (/^tomorrow$/i.test(trimmed)) {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

/**
 * "$2,400" → 2400   "$2.10/mi" → 2.10   "Call" → null   "" → null
 *
 * Returns null for "Call" / "Negotiable" / similar. Per-mile rates are
 * preserved as their numeric value; the rate type is inferred separately.
 */
export function parseRate(s: string | null | undefined): number | null {
  if (!s) return null;
  if (/call|negot/i.test(s)) return null;
  const m = s.replace(/,/g, '').match(/\$?\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

export function inferRateType(s: string | null | undefined): 'all_in' | 'per_mile' | 'per_km' {
  if (!s) return 'all_in';
  if (/\/mi|per\s*mi/i.test(s)) return 'per_mile';
  if (/\/km|per\s*km/i.test(s)) return 'per_km';
  return 'all_in';
}

/**
 * Normalize to E.164 (+1NXXNXXXXXX). Returns null for malformed input.
 *
 * "(705) 555-1861"      → "+17055551861"
 * "404-555-3344"        → "+14045553344"
 * "1 705 555 1861"      → "+17055551861"
 * "+1 587 555 9012 ext" → null   (extensions not supported; handled separately)
 * "555"                 → null
 *
 * Engine 2 uses the phone field for DNC matching, dedup, and Retell's
 * to_number — null is safer than wrong here.
 */
export function normalizePhone(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
