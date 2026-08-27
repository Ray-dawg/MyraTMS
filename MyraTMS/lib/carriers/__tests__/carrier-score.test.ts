import { describe, it, expect } from 'vitest';
import { computeScoreFromStats, type CarrierScoreStats } from '../carrier-score';

function baseStats(overrides: Partial<CarrierScoreStats> = {}): CarrierScoreStats {
  return {
    totalLoadsObserved: 10,
    onTimePct: 1,
    acceptanceRate: 1,
    cancellationRate: 0,
    claimsCount: 0,
    openRiskSignals: 0,
    ...overrides,
  };
}

describe('computeScoreFromStats', () => {
  it('returns NULL score when totalLoadsObserved < 5', () => {
    const r = computeScoreFromStats(baseStats({ totalLoadsObserved: 4 }));
    expect(r.score).toBeNull();
  });

  it('returns 100 for a perfect carrier with >= 5 loads', () => {
    const r = computeScoreFromStats(baseStats({ totalLoadsObserved: 5 }));
    expect(r.score).toBe(100);
  });

  it('applies the T-20 §4.5 formula exactly', () => {
    const stats = baseStats({
      totalLoadsObserved: 20,
      onTimePct: 0.8,
      acceptanceRate: 0.9,
      cancellationRate: 0.1,
      claimsCount: 1,
      openRiskSignals: 1,
    });
    // 100 - (0.1*40) - (0.2*25) - (0.1*15) - min(1*10,30) - min(1*15,40)
    // = 100 - 4 - 5 - 1.5 - 10 - 15 = 64.5
    const r = computeScoreFromStats(stats);
    expect(r.score).toBe(64.5);
  });

  it('caps claims penalty at 30 (3+ claims)', () => {
    const r = computeScoreFromStats(baseStats({ claimsCount: 10 }));
    expect(r.score).toBe(70); // 100 - min(100,30)
  });

  it('caps risk-signal penalty at 40 (3+ open signals)', () => {
    const r = computeScoreFromStats(baseStats({ openRiskSignals: 10 }));
    expect(r.score).toBe(60); // 100 - min(150,40)
  });

  it('floors at 0, never negative', () => {
    const r = computeScoreFromStats(baseStats({ cancellationRate: 1, onTimePct: 0, acceptanceRate: 0, claimsCount: 10, openRiskSignals: 10 }));
    expect(r.score).toBe(0);
  });

  it('treats missing onTimePct/acceptanceRate (no completions yet) as neutral, not penalized', () => {
    const r = computeScoreFromStats(baseStats({ totalLoadsObserved: 5, onTimePct: null, acceptanceRate: null }));
    expect(r.score).toBe(100);
  });
});
