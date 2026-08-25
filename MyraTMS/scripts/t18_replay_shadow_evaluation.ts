/**
 * T-18 replay harness: feeds T-17's `events` through evaluateAuthority()
 * in shadow mode, after the fact. Idempotent via authority_evaluations'
 * UNIQUE (source_event_id) — safe to re-run.
 *
 * Currently maps only 'call.initiated' events (the base spec's own worked
 * example, T-18 §3) to the 'voice' agent's 'place_call' action. Other event
 * types can be added to EVENT_TYPE_MAP as later modules define their own
 * agents/actions — this harness doesn't need to change shape to grow.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t18_replay_shadow_evaluation.ts
 */

import { db } from '../lib/pipeline/db-adapter';
import { evaluateAuthority } from '../lib/governance/evaluate-authority';

interface ReplayableEvent {
  id: number;
  tenant_id: number;
  pipeline_load_id: number | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
}

const EVENT_TYPE_MAP: Record<string, { agentKey: string; action: string }> = {
  'call.initiated': { agentKey: 'voice', action: 'place_call' },
};

export async function runReplay(): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  for (const [eventType, mapping] of Object.entries(EVENT_TYPE_MAP)) {
    const rows = await db.query<ReplayableEvent>(
      `SELECT e.id, e.tenant_id, e.pipeline_load_id, e.payload, e.correlation_id
         FROM events e
        WHERE e.event_type = $1
          AND NOT EXISTS (SELECT 1 FROM authority_evaluations ae WHERE ae.source_event_id = e.id)
        ORDER BY e.id`,
      [eventType],
    );

    for (const event of rows.rows) {
      try {
        await evaluateAuthority({
          agentKey: mapping.agentKey,
          tenantId: event.tenant_id,
          action: mapping.action,
          context: event.payload,
          sourceEventId: event.id,
          pipelineLoadId: event.pipeline_load_id ?? undefined,
          correlationId: event.correlation_id ?? undefined,
        });
        processed++;
      } catch (err) {
        errors++;
        console.error(`[t18-replay] failed on event ${event.id}:`, err);
      }
    }
    console.log(`[t18-replay] ${eventType}: ${rows.rows.length} events processed`);
  }

  return { processed, errors };
}

const isMainModule = process.argv[1]?.endsWith('t18_replay_shadow_evaluation.ts') ?? false;
if (isMainModule) {
  runReplay()
    .then(({ processed, errors }) => {
      console.log(`[t18-replay] done — ${processed} processed, ${errors} errors`);
      process.exit(errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('[t18-replay] fatal:', err);
      process.exit(1);
    });
}
