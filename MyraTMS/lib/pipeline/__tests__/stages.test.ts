import { describe, it, expect } from 'vitest';
import { PipelineStage, isValidTransition } from '@/lib/pipeline/stages';

describe('T-30 — MATCHED to BOOKED transition', () => {
  it('allows MATCHED -> BOOKED (email-tender loads skip briefed/calling)', () => {
    expect(isValidTransition(PipelineStage.MATCHED, PipelineStage.BOOKED)).toBe(true);
  });
});
