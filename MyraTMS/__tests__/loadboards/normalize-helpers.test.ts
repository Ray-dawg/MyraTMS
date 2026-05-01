/**
 * Pure unit tests for normalize-helpers — no DB, no Redis.
 * Same coverage shape as the scraper's parser tests, intentionally — the
 * two implementations should agree on every helper output.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCityState,
  inferCountry,
  normalizeEquipment,
  parseWeight,
  parseDate,
  parseRate,
  inferRateType,
  normalizePhone,
} from '@/lib/loadboards/normalize-helpers';

describe('normalize-helpers', () => {
  describe('parseCityState', () => {
    it('splits "Toronto, ON" cleanly', () => {
      expect(parseCityState('Toronto, ON')).toEqual(['Toronto', 'ON']);
      expect(parseCityState('Atlanta, GA')).toEqual(['Atlanta', 'GA']);
    });

    it('truncates long second segments to 2 chars (defends against "City, Ontario")', () => {
      expect(parseCityState('Sudbury, Ontario')).toEqual(['Sudbury', 'ON']);
    });

    it('handles missing state', () => {
      expect(parseCityState('Sudbury')).toEqual(['Sudbury', '']);
    });
  });

  describe('inferCountry', () => {
    it('maps Canadian provinces to CA', () => {
      expect(inferCountry('ON')).toBe('CA');
      expect(inferCountry('QC')).toBe('CA');
      expect(inferCountry('BC')).toBe('CA');
      expect(inferCountry('AB')).toBe('CA');
    });

    it('does NOT treat "CA" (California) as Canada — critical correctness test', () => {
      expect(inferCountry('CA')).toBe('US');
    });

    it('defaults to US for unknown / empty', () => {
      expect(inferCountry('')).toBe('US');
      expect(inferCountry('XX')).toBe('US');
    });
  });

  describe('normalizeEquipment', () => {
    it.each([
      ['Vans, Dry', 'dry_van'],
      ['Dry Van', 'dry_van'],
      ['DV', 'dry_van'],
      ['Vans, Reefer', 'reefer'],
      ['Refrigerated', 'reefer'],
      ['Flatbeds', 'flatbed'],
      ['FLAT', 'flatbed'],
      ['Step Deck', 'step_deck'],
      ['Tankers', 'tanker'],
      [null, 'dry_van'],
      ['', 'dry_van'],
    ])('maps "%s" → %s', (input, expected) => {
      expect(normalizeEquipment(input)).toBe(expected);
    });
  });

  describe('parseRate', () => {
    it('parses currency formats', () => {
      expect(parseRate('$1,800')).toBe(1800);
      expect(parseRate('$2,400')).toBe(2400);
      expect(parseRate('$2.10/mi')).toBe(2.1);
    });

    it('returns null for negotiable rates', () => {
      expect(parseRate('Call')).toBeNull();
      expect(parseRate('Negotiable')).toBeNull();
      expect(parseRate(null)).toBeNull();
    });
  });

  describe('inferRateType', () => {
    it('detects per_mile', () => {
      expect(inferRateType('$2.10/mi')).toBe('per_mile');
      expect(inferRateType('$1.30 per mi')).toBe('per_mile');
    });
    it('detects per_km', () => {
      expect(inferRateType('$0.85/km')).toBe('per_km');
    });
    it('defaults to all_in', () => {
      expect(inferRateType('$2,400')).toBe('all_in');
      expect(inferRateType(null)).toBe('all_in');
    });
  });

  describe('parseDate', () => {
    it('handles ISO', () => {
      expect(parseDate('2026-05-04')).toContain('2026-05-04');
    });
    it('handles "Today" and "Tomorrow"', () => {
      const today = parseDate('Today');
      expect(today.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(parseDate('Tomorrow').slice(0, 10)).toBe(tomorrow.toISOString().slice(0, 10));
    });
    it('falls back to today on garbage', () => {
      const v = parseDate('garbage-not-a-date');
      expect(v.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    });
  });

  describe('normalizePhone', () => {
    it.each([
      ['(705) 555-1861', '+17055551861'],
      ['404-555-3344', '+14045553344'],
      ['1 705 555 1861', '+17055551861'],
      ['+17055551861', '+17055551861'],
      ['555', null],
      [null, null],
      ['+1 587 555 9012 ext 4', null], // 12 digits → unrecognized
    ])('"%s" → %s', (input, expected) => {
      expect(normalizePhone(input)).toBe(expected);
    });
  });

  describe('parseWeight', () => {
    it('extracts integer pounds with comma separators', () => {
      expect(parseWeight('42,000')).toBe(42000);
      expect(parseWeight('38,500 lbs')).toBe(38500);
      expect(parseWeight('22000')).toBe(22000);
      expect(parseWeight(null)).toBeNull();
    });
  });
});
