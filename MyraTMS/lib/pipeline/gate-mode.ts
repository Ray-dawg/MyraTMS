/**
 * Single reader for the shipper-direct gate flags (E2-01 §4.11).
 * Exact-match, trimmed, lowercased — the same discipline as every other
 * Engine 2 kill switch. Read at call time, never cached at module load.
 */
export type GateMode = 'off' | 'shadow' | 'enforce';

const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();

export type EnvLike = Record<string, string | undefined>;

export function getShipperDirectGateMode(env: EnvLike = process.env): GateMode {
  if (norm(env.SHIPPER_DIRECT_GATE_ENABLED) !== 'true') return 'off';
  return norm(env.SHIPPER_DIRECT_GATE_MODE) === 'enforce' ? 'enforce' : 'shadow';
}

/**
 * Set by the operator at flip time (PRD §4.14 step 3). Rows created before
 * it are tolerated by M2's Compiler/Dispatcher assertions.
 */
export function getGateEnforcedAt(env: EnvLike = process.env): Date | null {
  const raw = env.SHIPPER_DIRECT_GATE_ENFORCED_AT;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
