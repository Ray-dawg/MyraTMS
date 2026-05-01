/**
 * ParsedRow → RawLoad normalization.
 *
 * RawLoad must match MyraTMS/lib/workers/scanner-worker.ts exactly — that is
 * the contract for every load in pipeline_loads, regardless of source. Any
 * field the scraper can't reliably populate is null; downstream agents
 * (Researcher, Compiler) handle missing data gracefully.
 *
 * Helpers (parseCityState, normalizeEquipment, parsePhone, etc.) handle the
 * specific quirks of DAT's UI: "$1,800" rates, "(555) 555-5555 ext 123"
 * phones, "Today/Tomorrow/12-15" dates.
 */

import type { ParsedRow } from '../adapters/base.js';
import type { DATParsedFields } from '../adapters/dat/parse.js';

export interface RawLoad {
  loadId: string;
  loadBoardSource: 'dat' | '123lb' | 'truckstop' | 'truckpath' | 'loadlink' | 'manual';
  sourceUrl: string | null;
  originCity: string;
  originState: string;
  originCountry: string;
  originLat: number | null;
  originLng: number | null;
  destinationCity: string;
  destinationState: string;
  destinationCountry: string;
  destinationLat: number | null;
  destinationLng: number | null;
  equipmentType: string;
  commodity: string | null;
  weightLbs: number | null;
  distanceMiles: number | null;
  pickupDate: string;
  pickupTimeWindow: string | null;
  deliveryDate: string | null;
  deliveryTimeWindow: string | null;
  postedRate: number | null;
  postedRateCurrency: string;
  rateType: string;
  shipperCompany: string | null;
  shipperContactName: string | null;
  shipperPhone: string | null;
  shipperEmail: string | null;
  postedAt: string;
  expiresAt: string | null;
  scannedAt: string;
}

const CA_PROVINCES = new Set([
  'ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU',
]);

export function normalizeDATRow(row: ParsedRow): RawLoad | null {
  const dat = row as ParsedRow & Partial<DATParsedFields>;
  if (!dat.loadId || !dat.origin || !dat.destination) return null;

  const [originCity, originState] = parseCityState(String(dat.origin));
  const [destCity, destState] = parseCityState(String(dat.destination));

  return {
    loadId: String(dat.loadId),
    loadBoardSource: 'dat',
    sourceUrl: null,
    originCity,
    originState,
    originCountry: inferCountry(originState),
    originLat: null,
    originLng: null,
    destinationCity: destCity,
    destinationState: destState,
    destinationCountry: inferCountry(destState),
    destinationLat: null,
    destinationLng: null,
    equipmentType: normalizeEquipment(typeof dat.equipment === 'string' ? dat.equipment : null),
    commodity: null,
    weightLbs: parseWeight(typeof dat.weight === 'string' ? dat.weight : null),
    distanceMiles: null, // computed downstream by Mapbox if missing
    pickupDate: parseDate(typeof dat.pickupDate === 'string' ? dat.pickupDate : null),
    pickupTimeWindow: null,
    deliveryDate: null,
    deliveryTimeWindow: null,
    postedRate: parseRate(typeof dat.rate === 'string' ? dat.rate : null),
    postedRateCurrency: 'USD', // DAT defaults to USD; override per market if needed
    rateType: inferRateType(typeof dat.rate === 'string' ? dat.rate : null),
    shipperCompany: typeof dat.broker === 'string' ? dat.broker : null,
    shipperContactName: null,
    shipperPhone: normalizePhone(typeof dat.phone === 'string' ? dat.phone : null),
    shipperEmail: null,
    postedAt: new Date().toISOString(),
    expiresAt: null,
    scannedAt: row.__scrapedAt,
  };
}

// ── Parsers ──────────────────────────────────────────────────────

export function parseCityState(s: string): [string, string] {
  // "Sudbury, ON" → ["Sudbury", "ON"]
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length >= 2 && parts[1]) {
    return [parts[0], parts[1].slice(0, 2).toUpperCase()];
  }
  return [s.trim(), ''];
}

export function inferCountry(state: string): string {
  if (!state) return 'US';
  return CA_PROVINCES.has(state.toUpperCase()) ? 'CA' : 'US';
}

export function normalizeEquipment(s: string | null): string {
  if (!s) return 'dry_van';
  const lower = s.toLowerCase();
  if (lower.includes('reefer') || lower.includes('refriger')) return 'reefer';
  if (lower.includes('flat')) return 'flatbed';
  if (lower.includes('step')) return 'step_deck';
  if (lower.includes('tank')) return 'tanker';
  if (lower.includes('van') || lower.includes('dry')) return 'dry_van';
  return 'dry_van'; // unknown → safest default; Qualifier will filter on equipment match
}

export function parseWeight(s: string | null): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseDate(s: string | null): string {
  if (!s) return new Date().toISOString();
  const trimmed = s.trim();
  if (/today/i.test(trimmed)) return new Date().toISOString();
  if (/tomorrow/i.test(trimmed)) {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

export function parseRate(s: string | null): number | null {
  if (!s) return null;
  if (/call|negot/i.test(s)) return null;
  const m = s.replace(/,/g, '').match(/\$?\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

export function inferRateType(s: string | null): string {
  if (!s) return 'all_in';
  if (/\/mi|per\s*mi/i.test(s)) return 'per_mile';
  if (/\/km|per\s*km/i.test(s)) return 'per_km';
  return 'all_in';
}

export function normalizePhone(s: string | null): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
