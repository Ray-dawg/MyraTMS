# GATE 2 — Gate enforcement flip + branch review (paste this whole prompt into a fresh session)

You are working in the MyraTMS monorepo at `C:\Users\patri\OneDrive\Desktop\M1`. **Open the session from the `M1/` root.** Read root `CLAUDE.md` + `Engine 2/CLAUDE.md` first. Binding rules: any change to `voice-worker`, `carrier-voice-worker`, `retell-webhook`, `compiler-worker`, `dispatcher-worker` or `dispatch-gate` is a live-call-path change requiring human review (risk E3-R1); explicit staging only; push is a separate confirmed step; keep the Engine 2 tracker in sync.

PRE-REQUISITES: Gate 0 and Gate 1 are done (calibration report exit 0; 24h shadow reviewed). If not, stop and say so.

## Mission

Get the shipper-direct gate from shadow to enforce, safely: (A) walk the operator through the outstanding human review of the E2-01 branch, (B) optionally build the DB-backed gate switch that removes the two-platform env-var ordering hazard, (C) execute the flip.

## Context

- The E2-01 enforcement work is merged on `master`: commits `edb99ba..a013746` + docs `53a41fb` + live-FMCSA fixes `d7c1f05`. A pre-generated review diff exists at `.superpowers/sdd/2026-10-07-e2-01-shipper-direct-gate-enforcement/review-2eed7ee..53a41fb.diff` (note: it predates `d7c1f05` — regenerate to include it). PRD §4.13 criterion 10 (operator's own review) is still OPEN. Four live-call-path files were touched: `MyraTMS/lib/workers/compiler-worker.ts`, `lib/workers/dispatcher-worker.ts`, `lib/pipeline/negotiation-brief.ts`, `lib/workers/qualifier-worker.ts`.
- Known caveat to disclose during review: commit `edb99ba` also contains another session's finished work (deliberately not history-rewritten; disclosed in the tracker).
- Gate mode logic: `MyraTMS/lib/pipeline/gate-mode.ts` — env-only. `getShipperDirectGateMode(env)` returns `'off'` unless `SHIPPER_DIRECT_GATE_ENABLED==='true'`, then `'enforce'` iff `SHIPPER_DIRECT_GATE_MODE==='enforce'` else `'shadow'`; `getGateEnforcedAt(env)` parses `SHIPPER_DIRECT_GATE_ENFORCED_AT` (ISO). The hazard: workers (Railway) and the import route (Vercel) read env independently, so the operator must flip Railway BEFORE Vercel or freshly-gated rows hit workers that don't assert yet. `lib/pipeline/load-source-assert.ts` tolerates NULL class only on rows older than `ENFORCED_AT`.
- The operator plans a MyraTMS control panel; a DB-backed switch is the desired end state (task B). Design constraints: single authoritative row (e.g. a `pipeline_settings`/gate-config table or reuse of the existing `settings` table — inspect it first), read via `db-adapter`, short-TTL cache in workers, env vars kept as a fallback/kill-switch override (env `off` must ALWAYS win — it is the emergency stop), admin API route super-admin-only (several Engine 3 routes had tenant-isolation IDORs; scope everything), migration script numbered after the latest in `MyraTMS/scripts/` and applied to production only as a separate confirmed step. Writing to it from the future control panel is out of scope; the API route is the hook.
- Retell contract: every `retell_llm_dynamic_variables` value must be a string. E2-01 added 3 variables (count 63 → 66): `load_source_class`, `poster_legal_name`, `co_broker_counterparty`. They must be declared on the Retell shipper agents (operator, Retell dashboard) BEFORE enforce, or calls have unfilled slots.

## Tasks (in order)

1. **(A) Branch review.** Regenerate the full diff including `d7c1f05`, split it into reviewable chunks (classifier, gate-mode, qualifier, assert + compiler/dispatcher, brief/Retell, scripts/tests, docs), and walk the operator through it chunk by chunk, flagging the four live-call-path files and the `edb99ba` caveat. Record their verdict in the tracker: criterion 10 → PASS (or the fixes they demand, which you implement test-first).
2. **(B) DB-backed gate switch (recommended — confirm with the operator, then build).** Test-first (vitest against dev-tests; `pnpm vitest run --no-file-parallelism`). Deliver: migration SQL + apply script, `gate-mode.ts` extended to consult the DB with env override precedence (env off > DB > env legacy values), a super-admin `GET/PATCH /api/admin/...` route, cache TTL ≤60s in workers, tests for precedence and fail-closed behaviour (DB unreachable → treat as current env values, never as enforce-off silently accepting). Update both CLAUDE.md flag sections + tracker in the same commit. Production migration apply = separate confirmed step.
3. Operator declares the 3 Retell dynamic variables (shipper agents). Verify by asking them to paste the agent variable list.
4. **(C) Flip.** With the DB switch: set `ENFORCED_AT=<now ISO>` then mode=enforce in one place; verify both Railway logs (Qualifier enforcing) and the Vercel import route behaviour. Without it: instruct the operator — `SHIPPER_DIRECT_GATE_ENFORCED_AT=<now ISO>` then `SHIPPER_DIRECT_GATE_MODE=enforce`, **Railway first, restart worker host, THEN Vercel**.
5. Watch the first day: Alert Center `load_source_review` rows resolve via `POST /api/pipeline/loads/:id/resolve-source`; any `load_source_assertion` CRITICAL exception = pipeline bug, stop and investigate immediately. If reviews exceed ~20/day after day 3, tighten `STRONG_BROKER_TOKENS` in `lib/pipeline/load-source-classifier.ts` (test-first) and re-calibrate.
6. Tracker + `docs/next-steps/ENGINE2.md` updated in the same commits.

## Exit criteria

- Criterion 10 PASS recorded with the operator's sign-off.
- 3 Retell variables declared and confirmed.
- Gate in enforce mode on both platforms (or via the DB switch); zero `load_source_assertion` exceptions; review queue ≤ manageable volume.
- If built: DB switch merged, tested, documented; migration applied to production as a confirmed step.
