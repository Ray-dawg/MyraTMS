// lib/exceptions/classification-rules.ts
//
// T-24 §4.3 — reads exception_classification_rules for the *new* source
// modules only (lifecycle_late, carrier_risk, stage_escalated, dead_letter).
// The existing 8 TMS rules in lib/exceptions/detector.ts never call this —
// they keep their own hardcoded severity logic (spec §4.3).

import { db } from '@/lib/pipeline/db-adapter';

export interface ClassificationRule {
  severity: string;
  slaMinutes: number;
  suggestedAction: string;
}

interface RuleRow {
  severity: string;
  sla_minutes: number;
  suggested_action: string;
  condition: Record<string, unknown>;
}

type Operator = '>=' | '>' | '<=' | '<' | '==';

function conditionMatches(condition: Record<string, unknown>, context: Record<string, number>): boolean {
  const keys = Object.keys(condition);
  if (keys.length === 0) return true; // {} — always matches, e.g. carrier_risk/stage_escalated/dead_letter

  return keys.every((key) => {
    const clause = condition[key];
    const actual = context[key];
    if (actual === undefined) return false;

    if (clause && typeof clause === 'object') {
      const entry = Object.entries(clause as Record<Operator, number>)[0];
      if (!entry) return false;
      const [op, threshold] = entry;
      switch (op as Operator) {
        case '>=': return actual >= threshold;
        case '>': return actual > threshold;
        case '<=': return actual <= threshold;
        case '<': return actual < threshold;
        case '==': return actual === threshold;
        default: return false;
      }
    }
    return actual === clause;
  });
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function matchClassificationRule(
  tenantId: number,
  sourceModule: string,
  context: Record<string, number>,
): Promise<ClassificationRule | null> {
  const { rows } = await db.query<RuleRow>(
    `SELECT severity, sla_minutes, suggested_action, condition
       FROM exception_classification_rules
      WHERE tenant_id = $1 AND source_module = $2 AND is_active = true`,
    [tenantId, sourceModule],
  );

  const matching = rows.filter((r) => conditionMatches(r.condition, context));
  if (matching.length === 0) return null;

  // Prefer the most severe matching tier — e.g. a load 400 minutes late
  // satisfies both the 20-minute and 360-minute lifecycle_late rules;
  // 'critical' (the more specific, harder-to-satisfy threshold) wins.
  matching.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99));
  const winner = matching[0];
  return { severity: winner.severity, slaMinutes: winner.sla_minutes, suggestedAction: winner.suggested_action };
}
