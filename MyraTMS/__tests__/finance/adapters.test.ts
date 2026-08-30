// __tests__/finance/adapters.test.ts
//
// Criterion 4: zero code path in this build can write environment =
// 'production'. Proven two ways here: (1) runtime — every INSERT's SQL
// text hardcodes the literal 'sandbox', never a bound parameter, so no
// caller-supplied value can reach that column; (2) compile-time — each
// adapter result type declares `environment: 'sandbox'` as a string
// LITERAL type, not `string`, so assigning 'production' fails tsc.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FactoringSubmissionResult } from '@/lib/finance/adapters/ecapital';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { submitToEcapitalSandbox, recordFactoringSubmission } from '@/lib/finance/adapters/ecapital';
import { disburseQuickPaySandbox, recordQuickPayDisbursement } from '@/lib/finance/adapters/stripe';
import { verifyKycSandbox, recordKycVerification } from '@/lib/finance/adapters/persona';

if (false) {
  // @ts-expect-error - environment is the literal type 'sandbox'; assigning 'production' must fail tsc
  const bad: FactoringSubmissionResult = { environment: 'production', ecapitalReferenceId: 'x', status: 'Submitted', advanceRate: 95, feePct: 5 };
}

describe('T-27 sandbox-only adapters (criterion 4)', () => {
  beforeEach(() => queryMock.mockReset());

  it('eCapital sandbox submission is always environment: sandbox', () => {
    const result = submitToEcapitalSandbox(5);
    expect(result.environment).toBe('sandbox');
    expect(result.status).toBe('Submitted');
    expect(result.advanceRate).toBe(95);
  });

  it('recordFactoringSubmission hardcodes the sandbox literal in SQL, not as a bound parameter', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const result = submitToEcapitalSandbox(5);
    await recordFactoringSubmission(42, result);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/'sandbox'/);
    expect(params).not.toContain('production');
  });

  it('Stripe sandbox disbursement is always environment: sandbox', () => {
    const result = disburseQuickPaySandbox(1000, 2.5);
    expect(result.environment).toBe('sandbox');
    expect(result.discountApplied).toBeCloseTo(25, 5);
  });

  it('recordQuickPayDisbursement hardcodes the sandbox literal in SQL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const result = disburseQuickPaySandbox(1000, 2.5);
    await recordQuickPayDisbursement(42, 7, 1000, result);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/'sandbox'/);
    expect(params).not.toContain('production');
  });

  it('Persona sandbox verification is always environment: sandbox', () => {
    const result = verifyKycSandbox();
    expect(result.environment).toBe('sandbox');
    expect(result.verificationStatus).toBe('pending');
  });

  it('recordKycVerification hardcodes the sandbox literal in SQL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const result = verifyKycSandbox();
    await recordKycVerification('carrier', 7, result);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/'sandbox'/);
    expect(params).not.toContain('production');
  });
});
