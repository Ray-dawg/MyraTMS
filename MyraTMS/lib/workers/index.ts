// @ts-nocheck
/**
 * Myra Logistics — Workers Barrel Export
 *
 * Single entry point for the Engine 2 worker layer. Bootstrap and the BullMQ
 * registrar import workers from here so we have one place to wire the
 * pipeline together.
 *
 * Source files map to lib/workers/*.ts in the runtime tree.
 *
 * @module lib/workers
 */

// ─── Base ────────────────────────────────────────────────────────────────────
export { default as BaseWorker } from './base-worker';

// ─── Agent 1: Scanner ────────────────────────────────────────────────────────
export { ScannerService } from './scanner-worker';

// ─── Agent 2: Qualifier ──────────────────────────────────────────────────────
export { QualifierWorker } from './qualifier-worker';

// ─── Agent 3: Researcher ─────────────────────────────────────────────────────
export { ResearcherWorker } from './researcher-worker';

// ─── Agent 4: Carrier Ranker ─────────────────────────────────────────────────
export { RankerWorker } from './ranker-worker';

// ─── Agent 5: Brief Compiler ─────────────────────────────────────────────────
export { CompilerWorker } from './compiler-worker';

// ─── Agent 6: Voice (Retell bridge) ──────────────────────────────────────────
export { VoiceWorker } from './voice-worker';

// ─── Agent 7: Dispatcher ─────────────────────────────────────────────────────
export { DispatcherWorker } from './dispatcher-worker';

// ─── Feedback Loop ───────────────────────────────────────────────────────────
export { FeedbackWorker } from './feedback-worker';

// ─── E2-04: Shipper Confirmation / Carrier Brief Compiler / Carrier Voice ────
// NOTE: named exports only, deliberately not wired into startAllWorkers()
// below -- that function's single-`deps`-arg signature has never matched any
// real worker constructor (each existing worker below takes its own
// distinct args: redis + one or more downstream Queue instances), and this
// file is @ts-nocheck'd, so nothing catches that drift. scripts/run-workers.ts
// is the actual boot path; it constructs every worker (including these 3)
// with its real signature directly. Not fixed here -- out of scope for
// E2-04, and startAllWorkers() was already unusable before this PRD.
export { ShipperConfirmationWorker } from './shipper-confirmation-worker';
export { CarrierBriefCompilerWorker } from './carrier-brief-compiler-worker';
export { CarrierVoiceWorker } from './carrier-voice-worker';

// ─── Convenience: register all workers in one call ───────────────────────────
import { QualifierWorker } from './qualifier-worker';
import { ResearcherWorker } from './researcher-worker';
import { RankerWorker } from './ranker-worker';
import { CompilerWorker } from './compiler-worker';
import { VoiceWorker } from './voice-worker';
import { DispatcherWorker } from './dispatcher-worker';
import { FeedbackWorker } from './feedback-worker';

/**
 * Instantiate every BullMQ-backed worker. Scanner runs as a polling cron, not
 * a queue worker, so it is started separately via cron-handlers.
 */
export function startAllWorkers(deps: any) {
  return {
    qualifier:  new QualifierWorker(deps),
    researcher: new ResearcherWorker(deps),
    ranker:     new RankerWorker(deps),
    compiler:   new CompilerWorker(deps),
    voice:      new VoiceWorker(deps),
    dispatcher: new DispatcherWorker(deps),
    feedback:   new FeedbackWorker(deps),
  };
}
