/**
 * T-18 seed: 8 existing Engine 2 workers + 2 Phase-2 placeholders into
 * `agents` (all status='shadow' per T-18 §4.1 — no agent goes 'active'
 * until T-18b), plus default envelopes for the 8 existing workers.
 *
 * Reads the four kill-switch env vars from process.env at seed time (not
 * hardcoded), per the spec's own instruction, and prints the kill-switch
 * mapping table from T-18 §5.1 so Patrice can verify it field-by-field
 * (acceptance criterion 2).
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t18_seed_governance.ts
 */

import { db } from '../lib/pipeline/db-adapter';
import { getMarginFloor } from '../lib/tenants/margin-floor';

interface AgentSeed {
  agent_key: string;
  display_name: string;
  agent_type: 'ingest' | 'decision' | 'communication' | 'financial' | 'orchestration';
  description: string;
}

const AGENTS: AgentSeed[] = [
  { agent_key: 'scanner', display_name: 'Scanner', agent_type: 'ingest', description: 'Pulls load candidates from load boards / CSV / scraper.' },
  { agent_key: 'qualifier', display_name: 'Qualifier', agent_type: 'decision', description: 'Filters loads for freshness, margin, equipment, DNC, fatigue.' },
  { agent_key: 'researcher', display_name: 'Researcher', agent_type: 'decision', description: 'Rate cascade + negotiation envelope calculation.' },
  { agent_key: 'ranker', display_name: 'Ranker', agent_type: 'decision', description: 'Carrier matching and scoring.' },
  { agent_key: 'compiler', display_name: 'Compiler', agent_type: 'decision', description: 'Compiles the negotiation brief and Retell payload.' },
  { agent_key: 'voice', display_name: 'Voice', agent_type: 'communication', description: 'Places carrier negotiation calls via Retell.' },
  { agent_key: 'dispatcher', display_name: 'Dispatcher', agent_type: 'orchestration', description: 'Books the load into the TMS and dispatches.' },
  { agent_key: 'feedback', display_name: 'Feedback', agent_type: 'decision', description: 'Scores outcomes, updates persona/shipper stats.' },
  { agent_key: 'negotiation', display_name: 'Negotiation (T-22, not yet built)', agent_type: 'communication', description: 'Placeholder for the bidirectional Negotiation Service.' },
  { agent_key: 'dispatch_one', display_name: 'Dispatch One (T-23, not yet built)', agent_type: 'orchestration', description: 'Placeholder for buy-side dispatch on behalf of owner-operators.' },
];

const VOICE_ENVELOPE_AGENT_KEY = 'voice';

async function seedAgents(): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const agent of AGENTS) {
    const r = await db.query<{ id: number }>(
      `INSERT INTO agents (agent_key, display_name, agent_type, status, description)
       VALUES ($1, $2, $3, 'shadow', $4)
       ON CONFLICT (agent_key) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [agent.agent_key, agent.display_name, agent.agent_type, agent.description],
    );
    ids.set(agent.agent_key, r.rows[0].id);
    console.log(`[t18-seed] agent '${agent.agent_key}' -> id ${r.rows[0].id}`);
  }
  return ids;
}

async function seedDefaultEnvelope(agentId: number, agentKey: string): Promise<void> {
  const existing = await db.query(
    `SELECT id FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = fn_myra_tenant_id() AND is_active = true`,
    [agentId],
  );
  if (existing.rows.length > 0) {
    console.log(`[t18-seed] envelope for '${agentKey}' already exists — skipping`);
    return;
  }

  const isVoice = agentKey === VOICE_ENVELOPE_AGENT_KEY;
  const maxConcurrentCalls = Number(process.env.MAX_CONCURRENT_CALLS ?? '1');
  // T-19: reads the live tenant_config value instead of carrying a frozen
  // copy of the (now removed) AUTO_BOOK_PROFIT_THRESHOLD env var, which was
  // never actually read by any real decision path (see T-19 design doc).
  const marginFloorCad = isVoice ? await getMarginFloor('CAD') : null;

  const permissions = isVoice
    ? { can: ['contact_carrier', 'negotiate_rate', 'book_load'], cannot: ['override_fraud_flag', 'modify_carrier_banking', 'approve_high_risk_payer'] }
    : { can: [], cannot: [] };
  const tools = isVoice ? ['retell_api', 'pipeline_loads_read', 'negotiation_brief_read'] : [];
  const budget = isVoice ? { max_concurrent: maxConcurrentCalls, max_actions_per_day: 200 } : {};
  const policies = isVoice ? { margin_floor_pct: 8, auto_book_profit_threshold_cad: marginFloorCad } : {};
  const escalationRules = isVoice
    ? [
        { trigger: 'fraud_signal_detected', level: 'L3' },
        { trigger: 'margin_below_floor', level: 'L3' },
        { trigger: 'confidence_below_threshold', level: 'L2' },
        { trigger: 'profit_above_auto_book_threshold', level: 'L1' },
      ]
    : [];

  await db.query(
    `INSERT INTO authority_envelopes (
       agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
       confidence_threshold, autonomy_default, escalation_rules, created_by
     ) VALUES ($1, fn_myra_tenant_id(), 1, $2, $3, $4, $5, $6, 0.700, 'L2', $7, 'system')`,
    [
      agentId,
      `${agentKey}-myra-default`,
      JSON.stringify(permissions),
      JSON.stringify(tools),
      JSON.stringify(budget),
      JSON.stringify(policies),
      JSON.stringify(escalationRules),
    ],
  );
  console.log(`[t18-seed] default envelope created for '${agentKey}'`);
}

async function printKillSwitchMapping(): Promise<void> {
  const values = {
    PIPELINE_ENABLED: process.env.PIPELINE_ENABLED ?? '(unset)',
    SCANNER_ENABLED: process.env.SCANNER_ENABLED ?? '(unset)',
    MAX_CONCURRENT_CALLS: process.env.MAX_CONCURRENT_CALLS ?? '(unset)',
  };
  const marginFloorCad = await getMarginFloor('CAD');
  const marginFloorUsd = await getMarginFloor('USD');
  console.log('\n[t18-seed] kill-switch -> envelope mapping (T-18 §5.1), current values:');
  console.log(`  PIPELINE_ENABLED=${values.PIPELINE_ENABLED} -> platform-level all-agents is_active (documented parity only, not enforced by T-18)`);
  console.log(`  SCANNER_ENABLED=${values.SCANNER_ENABLED} -> agents.status for agent_key='scanner' (all agents seeded 'shadow' regardless, per spec §4.1)`);
  console.log(`  MAX_CONCURRENT_CALLS=${values.MAX_CONCURRENT_CALLS} -> voice envelope budget.max_concurrent (live value, seeded above)`);
  console.log(`  margin floor (tenant_config, T-19): CAD $${marginFloorCad} / USD $${marginFloorUsd} -> voice envelope policies.auto_book_profit_threshold_cad`);
  console.log(`    *** Replaces AUTO_BOOK_PROFIT_THRESHOLD (removed, T-19) and tenant_config's now-corrected`);
  console.log(`    *** margin_floor_cad/usd keys. Same number that drives compiler/qualifier/researcher-worker.ts's`);
  console.log(`    *** auto_book_eligible decision now -- no longer a frozen, disconnected copy.`);
}

async function main(): Promise<void> {
  const agentIds = await seedAgents();
  for (const agent of AGENTS) {
    if (agent.agent_key === 'negotiation' || agent.agent_key === 'dispatch_one') continue; // no envelope yet — future modules define their own
    await seedDefaultEnvelope(agentIds.get(agent.agent_key)!, agent.agent_key);
  }
  await printKillSwitchMapping();
}

main()
  .then(() => {
    console.log('\n[t18-seed] done');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[t18-seed] failed:', err);
    process.exit(1);
  });
