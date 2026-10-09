# GATE 1 — Shipper-direct gate calibrated in shadow (paste this whole prompt into a fresh session)

You are working in the MyraTMS monorepo at `C:\Users\patri\OneDrive\Desktop\M1`. **Open the session from the `M1/` root.** Read the root `CLAUDE.md` and `Engine 2/CLAUDE.md` first; their rules are binding (explicit staging only, push and production-migration are separate confirmed steps, keep `Engine 2/docs/superpowers/plans/completion.md` in sync per task — never batch).

PRE-REQUISITE: Gate 0 is done (`FMCSA_QC_WEBKEY` set on Railway+Vercel; tenant-header fix deployed). If not, stop and say so.

## Mission

Seed the poster registry, backfill historical classification, and drive the calibration report to exit 0 — then run 24h of real shadow classification. This gates the double-brokering enforcement flip (E2-01).

## Context you must trust (established 2026-10-08 against the LIVE FMCSA API — do not re-litigate)

- **FMCSA cannot establish shipper-direct status.** Live-verified: every classic private fleet tested (Sysco Western Minnesota DOT 2374492, Sysco Asian Foods 292854, Kroger Dedicated Logistics 190793, Home Depot Supply 910928) also registers "Authorized For Hire"; Walmart Stores 1370797 returns an empty operation-classification list; SYSCO CORPORATION even holds active broker authority. So in `MyraTMS/lib/pipeline/load-source-classifier.ts`, the FMCSA `shipper_direct` accept branch is unreachable for real shippers. FMCSA can only REJECT (active broker authority → `broker_posted`) or ESCALATE (→ review). **Every accept comes from `poster_registry` or an import attestation. The registry is load-bearing.** PRD §4.13 criterion 2 is recorded as FAIL/unsatisfiable-as-written in the tracker (entry dated 2026-10-08).
- The authority lookup was fixed in commit `d7c1f05` (three live-API bugs: missing `/operation-classification` sub-resource, object-vs-list `content` shape on `/carriers/{dot}`, 4s timeout vs 10–20s real latency — now 25s default via `AUTHORITY_LOOKUP_TIMEOUT_MS`). The suite `MyraTMS/__tests__/verification/authority-lookup.test.ts` is 14/14 green. Don't redo this work.
- `authority_lookups` caches results (including `not_found`, TTL 1 day via `AUTHORITY_LOOKUP_CACHE_DAYS`). If you change lookup code, clear the affected `lookup_key` rows before re-testing, or stale misses will mislead you.
- DB access in scripts goes through `lib/pipeline/db-adapter.ts` (`db.query(text, params)`, autocommit per statement, `transaction()` is a passthrough — write idempotent ordered statements). Neon returns BIGINT as strings.
- `MyraTMS/.env.local` points at the Neon **dev-tests** branch; production runs are a separate explicitly-confirmed step with the production `DATABASE_URL` (tests refuse it via `lib/db/production-guard.ts`; `ALLOW_PROD_TESTS=1` is the only escape hatch and only for confirmed verification runs). The backfill/calibration over REAL `pipeline_loads` must run against production READS — confirm with the operator before pointing any script at production, and prefer running the scripts with an explicit env override rather than editing `.env.local`.

## Inputs you need from the operator (ask for them up front)

- **The labels CSV** for `scripts/e2_seed_poster_registry.ts` (shipper list ~205 rows + mines rows + broker list + the operator's judgment labels). Read the script first to learn its exact CSV contract before asking, and tell the operator the required columns.

## Tasks (in order)

1. Read `MyraTMS/scripts/e2_seed_poster_registry.ts`, `scripts/e2_backfill_load_source.ts`, `scripts/e2_source_calibration_report.ts`, and `lib/pipeline/load-source-classifier.ts` end-to-end. Also read the rollout checklist: `docs/next-steps/ENGINE2.md` § "Shipper-direct gate flip" (steps 1–7, already renumbered).
2. Dry-run the seed on the dev-tests branch with the operator's CSV: `cd MyraTMS && pnpm tsx --env-file=.env.local scripts/e2_seed_poster_registry.ts <csv>`. Verify row counts vs the manifest (PRD §4.13 criterion 5) with a direct `poster_registry` count query.
3. With operator confirmation, run seed + backfill against production (reads/writes limited to `poster_registry`, `authority_lookups`, and `pipeline_loads.load_source_*` columns — confirm the scripts touch nothing else before running): `scripts/e2_backfill_load_source.ts`.
4. Run `scripts/e2_source_calibration_report.ts` — it **must exit 0** (exit 1 means a human-labelled broker was accepted at some point). If non-zero or if `unresolvedTopPosters` is large: present the list to the operator, get labels, re-seed, re-run. Iterate until exit 0. Save the final JSON output to `.superpowers/` or hand it to the operator (it is attached to the PR per criterion 4).
5. Ask the operator to set `SHIPPER_DIRECT_GATE_ENABLED=true` and `SHIPPER_DIRECT_GATE_MODE=shadow` on Railway (exact-match flags, beware trailing whitespace). NOTHING blocks in shadow mode.
6. After 24h of real ingest, report: distribution of `load_source_class` over new `pipeline_loads`, registry hit rate, review-rate projection (every miss becomes a human review task in enforce mode). Re-run the calibration report.
7. Tracker discipline: record the seed counts, calibration result and shadow stats in `Engine 2/docs/superpowers/plans/completion.md` (dated entry) in the same commit as any code/doc change. PRD §4.13 criteria 4 and 5 move from OPEN to PASS here — say so explicitly in the entry.

## Exit criteria

- `poster_registry` seeded, counts match the manifest (criterion 5 PASS).
- Backfill completed over real `pipeline_loads`; calibration report exits 0 (criterion 4 PASS) with the JSON saved.
- 24h shadow stats reported with a registry hit rate the operator accepts.
- Tracker updated. No enforce flip in this gate — that is Gate 2.
