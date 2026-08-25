/**
 * T-19 threshold consolidation — before/after parity.
 *
 * getMarginFloor() replaces three independently hardcoded
 * `currency === 'CAD' ? 270 : 200` literals (compiler-worker.ts,
 * qualifier-worker.ts, researcher-worker.ts) with a single tenant_config
 * read. This test asserts the effective value is unchanged for every
 * currency case — a refactor, not a behavior change. Requires DATABASE_URL
 * pointed at a database where migration 035 has run (so margin_floor_cad/usd
 * are corrected to 270/200).
 */

import { describe, it, expect } from 'vitest';
import { getMarginFloor } from '../margin-floor';

const OLD_HARDCODED_LOGIC: Record<'CAD' | 'USD', number> = {
  CAD: 270,
  USD: 200,
};

describe('getMarginFloor — parity with the old hardcoded literals', () => {
  it('CAD matches the old hardcoded value (270)', async () => {
    expect(await getMarginFloor('CAD')).toBe(OLD_HARDCODED_LOGIC.CAD);
  });

  it('USD matches the old hardcoded value (200)', async () => {
    expect(await getMarginFloor('USD')).toBe(OLD_HARDCODED_LOGIC.USD);
  });

  it('throws a clear error for a tenant_config key that does not exist', async () => {
    // @ts-expect-error deliberately invalid currency to exercise the not-found path
    await expect(getMarginFloor('EUR')).rejects.toThrow(/no tenant_config row/);
  });
});
