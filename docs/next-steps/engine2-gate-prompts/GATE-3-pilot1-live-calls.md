# GATE 3 — Pilot 1 / Phase 6B: first live calls to consenting shippers (paste this whole prompt into a fresh session)

You are working in the MyraTMS monorepo at `C:\Users\patri\OneDrive\Desktop\M1`. **Open the session from the `M1/` root.** Read root `CLAUDE.md`, `Engine 2/CLAUDE.md`, and `scripts/sprint6-shadow/` runbook in `MyraTMS/` before anything else. Binding rules: NO edits to live-call-path files (`voice-worker`, `carrier-voice-worker`, `retell-webhook`, `compiler-worker`, `dispatcher-worker`, `dispatch-gate`) without human review; push/migrations are separate confirmed steps.

PRE-REQUISITES: Gates 0–2 done (tenant-header fix live, env hygiene confirmed, shipper-direct gate enforcing cleanly). If not, stop and say so.

## Mission

Run Phase 6B — real Retell calls to ~10 consenting test shippers — and record the Engine 3 handoff-gate numbers. This has NEVER run: exactly one live call has ever been placed (2026-06-06, to the operator's own number). You are the co-pilot; the operator drives every irreversible step.

## Context

- Pipeline: Scanner → Qualifier → Researcher‖Ranker → Compiler → Voice → Dispatcher; workers on Railway (`myratms-workers`, boots via `scripts/run-workers.ts`), crons on Vercel, shared Upstash Redis (ioredis TCP for BullMQ) + Neon Postgres. Stage machine in `lib/pipeline/stages.ts`.
- Kill switches (exact-match after `.trim().toLowerCase()`): `PIPELINE_ENABLED`, `SCANNER_ENABLED`, `MAX_CONCURRENT_CALLS` (0 = shadow), `CARRIER_CALLS_ENABLED` (stays false), `CARRIER_AUTO_ASSIGN_ENABLED` (false), `SHIPPER_CONFIRMATION_ENABLED` (false for this gate).
- Operator scripts: `MyraTMS/scripts/sprint6-shadow/` — 7 scripts + runbook, including `07-emergency-stop.ts`. Read all 7 and the runbook; verify they still match the current schema before relying on them. KNOWN BUG: `06-cleanup.ts` FK-violates against `exceptions` — `exceptions.pipeline_load_id` is INTEGER referencing `pipeline_loads(id)` (surrogate PK), not the TEXT `load_id` business key; any census keyed on `TEST-…` strings returns 0 and the delete fails. Fix it (key on the PK) BEFORE the pilot, test on dev-tests.
- Import path: `POST /api/pipeline/import` with Bearer `PIPELINE_IMPORT_TOKEN`; with the gate enforced the payload needs the shipper-direct attestation fields (see `__tests__/pipeline/pipeline-import-attestation` tests for the contract) or it 400s.
- Retell: account provisioned; 3 shipper personas + webhook at `/api/webhooks/retell-callback` (HMAC `RETELL_WEBHOOK_SECRET`). The 66 dynamic variables must all be strings. Calling-hours logic in `lib/pipeline/time.ts`.
- Compliance: consent is logged (`consent_log`), DNC respected (`dnc_list`) — the 10 shippers must have recorded consent before any call. The Dispatcher refuses `carrier_status='prospect'` carriers by design; preserve.
- Success evidence for one full chain: `agent_calls` row with parsed outcome → `pipeline_loads` stage `booked` → `loads` row with `booked_via='ai_auto'` → tracking email sent.

## Tasks (in order)

1. **Pre-flight (no calls).** Fix `06-cleanup.ts` (test on dev-tests). Re-verify worker health: operator checks Railway logs show 10 workers booted; run the pipeline-health cron manually (`/api/cron/pipeline-health` with `CRON_SECRET`) and triage any stuck/dead-letter findings. Verify `RETELL_*` env vars present (operator pastes names, never values).
2. **Consent + data.** Operator supplies the 10 consenting shippers (names, numbers, consent timestamps) and their real loads. Insert consent rows per the existing `consent_log` contract. Prepare the import batch CSV/payload with attestation `yes`.
3. **Dry chain in shadow.** With `MAX_CONCURRENT_CALLS=0`, import one load, watch it travel scanned→…→calling-blocked; confirm the brief (`negotiation_briefs`) renders all 66 variables as strings and `load_source_class` is populated.
4. **Go live, minimum blast radius.** Operator sets `MAX_CONCURRENT_CALLS=1` (Railway), restarts worker host, keeps `07-emergency-stop.ts` ready in a second terminal, and listens live in the Retell dashboard. Import the batch. You watch the DB/webhook side in near-real-time (poll `agent_calls`, `pipeline_loads`, `exceptions`).
5. Verify ONE full booking chain lands (evidence above). Verify webhook signature + event ordering on real calls (this is an Engine 3 handoff-gate item).
6. **Record the numbers** (deploy plan Task 4.6 / Engine 3 handoff inputs): connect rate, book rate, cost per call, webhook ordering anomalies, per-call duration/latency. Write them into `Engine 2/docs/superpowers/plans/completion.md` as a dated entry and update `docs/next-steps/ENGINE2.md`.
7. After the window: calls back to `MAX_CONCURRENT_CALLS=0` unless the operator explicitly chooses to stay live; run the (fixed) cleanup for any test rows; report.

## Hard rules

- You never flip an env var yourself; the operator does, and confirms each value.
- Any `load_source_assertion` or webhook-verification failure = stop calls (emergency stop), diagnose with `superpowers:systematic-debugging`, do not resume until root-caused.
- No real shipper without logged consent. DNC list wins over everything.

## Exit criteria

- ≥1 clean end-to-end booking with full evidence chain; emergency stop exercised at least once (deliberately, on a test load if needed).
- Webhook verifier + ordering confirmed on real calls.
- Connect/book/cost metrics recorded in the tracker.
- Calls returned to the agreed steady state.
