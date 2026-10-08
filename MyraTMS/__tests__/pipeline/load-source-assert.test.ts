import { describe, it, expect } from 'vitest';
import { assertLoadSource } from '@/lib/pipeline/load-source-assert';

const ENFORCE = {
  SHIPPER_DIRECT_GATE_ENABLED: 'true',
  SHIPPER_DIRECT_GATE_MODE: 'enforce',
  SHIPPER_DIRECT_GATE_ENFORCED_AT: '2026-11-01T00:00:00Z',
};

describe('assertLoadSource (E2-01 M2)', () => {
  it('passes shipper_direct and co_brokered', () => {
    expect(assertLoadSource({ load_source_class: 'shipper_direct', created_at: '2026-11-02T00:00:00Z' }, 'compiler', ENFORCE).ok).toBe(true);
    expect(assertLoadSource({ load_source_class: 'co_brokered', created_at: '2026-11-02T00:00:00Z' }, 'dispatcher', ENFORCE).ok).toBe(true);
  });

  it('fails broker_posted and unresolved with a stage-specific code', () => {
    const r = assertLoadSource({ load_source_class: 'broker_posted', created_at: '2026-11-02T00:00:00Z' }, 'compiler', ENFORCE);
    expect(r).toMatchObject({ ok: false, reasonCode: 'source_assertion_failed_compiler' });
    expect(assertLoadSource({ load_source_class: null, created_at: '2026-11-02T00:00:00Z' }, 'dispatcher', ENFORCE)).toMatchObject({
      ok: false,
      reasonCode: 'source_assertion_failed_dispatcher',
    });
  });

  it('tolerates NULL class on rows created before the enforcement timestamp', () => {
    expect(assertLoadSource({ load_source_class: null, created_at: '2026-10-01T00:00:00Z' }, 'compiler', ENFORCE).ok).toBe(true);
  });

  it('is a no-op in shadow or off mode', () => {
    expect(assertLoadSource({ load_source_class: 'broker_posted', created_at: '2026-11-02T00:00:00Z' }, 'compiler', { ...ENFORCE, SHIPPER_DIRECT_GATE_MODE: 'shadow' }).ok).toBe(true);
    expect(assertLoadSource({ load_source_class: 'broker_posted', created_at: '2026-11-02T00:00:00Z' }, 'compiler', {}).ok).toBe(true);
  });
});
