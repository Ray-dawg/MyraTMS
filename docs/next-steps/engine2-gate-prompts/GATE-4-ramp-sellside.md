# GATE 4 — Ramp, sell-side loop, middleware & tenanting (paste this whole prompt into a fresh session)

You are working in the MyraTMS monorepo at `C:\Users\patri\OneDrive\Desktop\M1`. **Open the session from the `M1/` root.** Read root `CLAUDE.md`, `Engine 2/CLAUDE.md`, `Engine 3/CLAUDE.md`, and `docs/next-steps/ENGINE2.md`. Binding rules as in prior gates (live-call-path review, explicit staging, separate confirmed push/migration steps, tracker sync per task).

PRE-REQUISITE: Gate 3 done — Pilot 1 green with recorded connect/book/cost metrics. If not, stop and say so. This gate is a menu of four workstreams; confirm with the operator which to run and in what order (recommended: A → B, C and D as capacity allows).

## Workstream A — Concurrency ramp

- Raise `MAX_CONCURRENT_CALLS` stepwise (1 → 3 → 5 → …), each step held until the green-light criteria from the Pilot 1 sign-off are met at that level (no webhook ordering anomalies, dead-letter queue empty, cost-per-call within budget). Never jump back to 25 (the value once found live by accident — see root CLAUDE.md Known Issues).
- You monitor `agent_calls`/`exceptions`/pipeline-health between steps; the operator changes the value.

## Workstream B — Sell-side loop (E2-03/E2-04: shipper confirmation → carrier cascade)

Code-complete, merged, NEVER run in production; no carrier has ever been called. Blocked on IMAP.

1. Operator provisions a dedicated mailbox and supplies `IMAP_HOST/PORT/USER/PASS` (+ `SMTP_*` confirmed working). NEVER print credentials.
2. Deploy `scripts/run-imap-poller.ts` as a THIRD Railway service (alongside `myratms-workers` and the scraper): `pnpm tsx scripts/run-imap-poller.ts`. The poller is injected-client by design (`lib/email/imap-poller.ts`) — test locally against the real mailbox once before deploying, with `INBOUND_EMAIL_POLLING_ENABLED` still false in prod.
3. Shadow-drain the confirmation flow first: `SHIPPER_CONFIRMATION_ENABLED=true`, `CARRIER_CALLS_ENABLED=false`. Exercise: confirmation PDF (`lib/shipper-rate-confirmation.ts`), One_pager confirm mode (`/track/[token]` in confirm mode), nudge/escalate timers, inbound classifier (`lib/email/inbound-classifier.ts`), T-26 term extraction on the `shipper_reply` branch.
4. Only after that holds: `CARRIER_CALLS_ENABLED=true` with the cascade (`lib/pipeline/carrier-cascade.ts`, `decideCascadeAction()`), rate-con dispatch gate (`lib/dispatch-gate.ts` — Dispatched ONLY after signed rate-con), carrier verification (`lib/verification/`). The Dispatcher's refusal of `carrier_status='prospect'` carriers must be preserved.
5. Tracker entries per milestone; E2-04 acceptance criteria that were held open move to PASS/FAIL with evidence.

## Workstream C — Enable middleware for real (finishes the Gate 0 security story)

The tenant-header fix is live, but `middleware.ts` routing itself is still effectively off. Enabling it as-is would 401: 8 `/api/cron/*` routes (Bearer `CRON_SECRET`), `/api/pipeline/import` (Bearer `PIPELINE_IMPORT_TOKEN`), `/api/webhooks/retell-callback` (HMAC), `/api/confirmations/[token]`, plus `/track/[token]` style public paths.

1. Enumerate EVERY route under `MyraTMS/app/api/` and classify its auth mechanism (JWT cookie, Bearer service token, HMAC, token-in-path, public). Build the corrected `publicPaths`/matcher from that census, not from the old list.
2. Regression tests: compile the exported matcher with Next's `getMiddlewareMatchers` (pattern already exists in the Gate-0 test) and assert each census row matches/bypasses as classified.
3. Stage rollout: deploy with middleware ON in a preview deployment first; replay one request per auth class (operator triggers a real cron run, a Retell test webhook, a confirmation click) before promoting to production.
4. Verify driver-JWT path restriction now actually binds (driver token must NOT reach `/api/shippers`, `/api/carriers`, `/api/invoices`).

## Workstream D — Engine 2 tenanting (migration 030) + scraper decision

- Pre-condition written into the staged file: Engine 2 stable in production ≥24h of real volume. Apply `MyraTMS/scripts/030_engine2_tenanting.sql.PENDING` (rename, review against current schema — it was staged long ago), as a separate explicitly-confirmed production step with its rollback path. Never hardcode tenant ids; use `fn_myra_tenant_id()`/`getMyraTenantId()`.
- Decide with the operator: deploy the headless `scraper/` to Railway (roadmap A.3.3, Dockerfile exists, registry has `dat='scrape'`) or retire it in favour of official APIs (`lib/loadboards/` clients are still stubs — going official means building one client off stubs, which is also an Engine 3 handoff-gate item).

## Exit criteria

- A: steady-state concurrency agreed and held for a week without critical exceptions.
- B: one real load through shipper-confirm → carrier-called → signed rate-con → Dispatched, fully evidenced.
- C: middleware on in production; all auth classes verified working; driver-token restriction enforced.
- D: migration 030 applied + verified, or an explicit recorded decision to defer; scraper decision recorded.
- Trackers and both CLAUDE.md files updated with each landing, same-commit.
