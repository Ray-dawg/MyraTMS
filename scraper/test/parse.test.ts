/**
 * Parser regression test using a synthetic DAT-shaped HTML fixture.
 *
 * Why this matters: when DAT changes its UI, the production scraper goes
 * silent and produces zero rows. This test catches selector breakage and
 * normalization regressions BEFORE deploy. Update the fixture when DAT
 * legitimately rebrands.
 *
 * The test drives the same parser the production code uses
 * (parseDATResultsFromDocument), via JSDOM. So this is a true regression
 * net for the live path.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDATResultsFromDocument } from '../src/adapters/dat/parse.js';
import { DAT_SELECTORS } from '../src/adapters/dat/selectors.js';
import {
  normalizeDATRow,
  parseCityState,
  inferCountry,
  normalizeEquipment,
  parseRate,
  inferRateType,
  parseDate,
  normalizePhone,
  parseWeight,
} from '../src/pipeline/normalize.js';
import type { ParsedRow } from '../src/adapters/base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, 'fixtures', 'dat-results.html');

function loadFixture(): Document {
  const html = readFileSync(FIXTURE_PATH, 'utf8');
  const dom = new JSDOM(html);
  return dom.window.document;
}

describe('parseDATResultsFromDocument', () => {
  it('extracts every result row from the fixture (including ones missing required fields)', () => {
    const doc = loadFixture();
    const rows = parseDATResultsFromDocument(doc, DAT_SELECTORS);
    // 5 rows in the fixture (4 valid + 1 missing required fields)
    expect(rows.length).toBe(5);
  });

  it('captures expected fields for the first row', () => {
    const doc = loadFixture();
    const [first] = parseDATResultsFromDocument(doc, DAT_SELECTORS);
    expect(first.loadId).toBe('DAT-12345');
    expect(first.origin).toBe('Toronto, ON');
    expect(first.destination).toBe('Sudbury, ON');
    expect(first.equipment).toBe('Vans, Dry');
    expect(first.rate).toBe('$2,400');
    expect(first.broker).toBe('Northern Mine Supply Co');
    expect(first.phone).toBe('(705) 555-1861');
    expect(first.weight).toBe('42,000');
  });

  it('preserves rowHTML for forensic re-parsing (bounded to 4kb)', () => {
    const doc = loadFixture();
    const [first] = parseDATResultsFromDocument(doc, DAT_SELECTORS);
    expect(first.rowHTML).toContain('DAT-12345');
    expect(first.rowHTML.length).toBeLessThanOrEqual(4000);
  });
});

describe('normalizeDATRow', () => {
  function asParsedRow(fields: Record<string, string | null>): ParsedRow {
    return {
      ...fields,
      __source: 'dat',
      __scrapedAt: new Date().toISOString(),
    } as ParsedRow;
  }

  it('produces a valid RawLoad for a complete DAT row', () => {
    const row = asParsedRow({
      loadId: 'DAT-12345',
      origin: 'Toronto, ON',
      destination: 'Sudbury, ON',
      equipment: 'Vans, Dry',
      pickupDate: '2026-05-04',
      weight: '42,000',
      length: "53'",
      rate: '$2,400',
      broker: 'Northern Mine Supply Co',
      phone: '(705) 555-1861',
      rowHTML: '<tr/>',
    });
    const load = normalizeDATRow(row);
    expect(load).not.toBeNull();
    expect(load!.loadId).toBe('DAT-12345');
    expect(load!.loadBoardSource).toBe('dat');
    expect(load!.originCity).toBe('Toronto');
    expect(load!.originState).toBe('ON');
    expect(load!.originCountry).toBe('CA');
    expect(load!.destinationCity).toBe('Sudbury');
    expect(load!.destinationCountry).toBe('CA');
    expect(load!.equipmentType).toBe('dry_van');
    expect(load!.weightLbs).toBe(42000);
    expect(load!.postedRate).toBe(2400);
    expect(load!.rateType).toBe('all_in');
    expect(load!.shipperPhone).toBe('+17055551861');
  });

  it('returns null when required fields are missing', () => {
    const row = asParsedRow({
      loadId: null,
      origin: null,
      destination: 'Boston, MA',
      equipment: 'Vans, Dry',
      pickupDate: '2026-05-06',
      weight: '30,000',
      length: "53'",
      rate: '$1,800',
      broker: 'Beacon Logistics',
      phone: '617-555-7766',
      rowHTML: '<tr/>',
    });
    expect(normalizeDATRow(row)).toBeNull();
  });

  it('handles US lanes — country inferred to US', () => {
    const row = asParsedRow({
      loadId: 'DAT-12347',
      origin: 'Atlanta, GA',
      destination: 'Miami, FL',
      equipment: 'Flatbeds',
      pickupDate: 'Tomorrow',
      weight: '45,000',
      length: "48'",
      rate: '$2.10/mi',
      broker: 'Sun Belt Freight',
      phone: '404-555-3344',
      rowHTML: '<tr/>',
    });
    const load = normalizeDATRow(row);
    expect(load).not.toBeNull();
    expect(load!.originCountry).toBe('US');
    expect(load!.destinationCountry).toBe('US');
    expect(load!.equipmentType).toBe('flatbed');
    expect(load!.rateType).toBe('per_mile');
    expect(load!.postedRate).toBe(2.10);
    expect(load!.shipperPhone).toBe('+14045553344');
  });

  it('handles "Call" (negotiable) rate by setting postedRate to null', () => {
    const row = asParsedRow({
      loadId: 'DAT-12348',
      origin: 'Chicago, IL',
      destination: 'Detroit, MI',
      equipment: 'Vans, Dry',
      pickupDate: 'Today',
      weight: '22,000',
      length: "53'",
      rate: 'Call',
      broker: 'Midwest Brokerage Inc',
      phone: null,
      rowHTML: '<tr/>',
    });
    const load = normalizeDATRow(row);
    expect(load).not.toBeNull();
    expect(load!.postedRate).toBeNull();
    expect(load!.shipperPhone).toBeNull();
  });
});

describe('helpers', () => {
  it('parseCityState splits "Toronto, ON" correctly', () => {
    expect(parseCityState('Toronto, ON')).toEqual(['Toronto', 'ON']);
    expect(parseCityState('Atlanta, GA')).toEqual(['Atlanta', 'GA']);
  });

  it('inferCountry recognizes Canadian provinces', () => {
    expect(inferCountry('ON')).toBe('CA');
    expect(inferCountry('QC')).toBe('CA');
    expect(inferCountry('BC')).toBe('CA');
    expect(inferCountry('CA')).toBe('US'); // 'CA' is California, not Canada
    expect(inferCountry('GA')).toBe('US');
    expect(inferCountry('')).toBe('US');
  });

  it('normalizeEquipment maps DAT labels to canonical types', () => {
    expect(normalizeEquipment('Vans, Dry')).toBe('dry_van');
    expect(normalizeEquipment('Vans, Reefer')).toBe('reefer');
    expect(normalizeEquipment('Flatbeds')).toBe('flatbed');
    expect(normalizeEquipment('Step Decks')).toBe('step_deck');
    expect(normalizeEquipment('Tankers')).toBe('tanker');
    expect(normalizeEquipment(null)).toBe('dry_van');
  });

  it('parseRate handles $1,800, $2.10/mi, and "Call"', () => {
    expect(parseRate('$1,800')).toBe(1800);
    expect(parseRate('$2.10/mi')).toBe(2.1);
    expect(parseRate('$2,400')).toBe(2400);
    expect(parseRate('Call')).toBeNull();
    expect(parseRate('Negotiable')).toBeNull();
    expect(parseRate(null)).toBeNull();
  });

  it('inferRateType detects per_mile and per_km', () => {
    expect(inferRateType('$2.10/mi')).toBe('per_mile');
    expect(inferRateType('$1.30 per mi')).toBe('per_mile');
    expect(inferRateType('$0.85/km')).toBe('per_km');
    expect(inferRateType('$2,400')).toBe('all_in');
  });

  it('parseDate handles ISO + Today/Tomorrow', () => {
    expect(parseDate('2026-05-04')).toContain('2026-05-04');
    const today = parseDate('Today');
    expect(today.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(parseDate('Tomorrow').slice(0, 10)).toBe(tomorrow.toISOString().slice(0, 10));
  });

  it('normalizePhone handles 10-digit, 11-digit, and "+1" formats', () => {
    expect(normalizePhone('(705) 555-1861')).toBe('+17055551861');
    expect(normalizePhone('+1 587 555 9012 ext 4')).toBeNull(); // 12 digits, not 11 → unrecognized
    expect(normalizePhone('404-555-3344')).toBe('+14045553344');
    expect(normalizePhone('17055551861')).toBe('+17055551861');
    expect(normalizePhone('555')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('parseWeight extracts integer pounds with comma-thousand separators', () => {
    expect(parseWeight('42,000')).toBe(42000);
    expect(parseWeight('38,500 lbs')).toBe(38500);
    expect(parseWeight('22000')).toBe(22000);
    expect(parseWeight(null)).toBeNull();
  });
});
