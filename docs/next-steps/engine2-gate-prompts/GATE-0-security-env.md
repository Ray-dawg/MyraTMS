# GATE 0 — Security & environment hygiene (paste this whole prompt into a fresh session)

You are working in the MyraTMS monorepo at `C:\Users\patri\OneDrive\Desktop\M1`. **Open the session from the `M1/` root** (sessions launched from a subdirectory cannot Read/Edit sibling directories). Read the root `CLAUDE.md` first — its rules are binding, especially: never `git add -A` (stage explicit paths); pushing is a separate explicitly-confirmed step; applying a migration to production is a separate explicitly-confirmed step; never hardcode a tenant id.

## Mission

Close the security and environment holes that block Engine 2 from ever placing live calls. Nothing in later gates may start until this gate's exit criteria are green.

## Context you must trust (verified 2026-10-08/09, do not re-litigate)

- 🔴 `middleware.ts` has NEVER run in production. Its `config.matcher` has two bugs (unbalanced paren compiled into the regex, plus `"\."` in a double-quoted TS string collapsing to `.`), so it matches no path. Consequence 1: `getTenantContext()` in `MyraTMS/lib/auth.ts` trusted the `x-myra-tenant-id` request header, so `curl -H "x-myra-tenant-id: 2" https://<prod>/api/loads` returned another tenant's rows with NO credentials (confirmed HTTP 200). Consequence 2: driver-JWT path restriction exists only in middleware, so driver tokens reach `/api/shippers`, `/api/carriers`, `/api/invoices`.
- The fix already exists on branch **`fix-tenant-header-bypass`**: `getTenantContext()` derives tenant from the signed JWT and never from headers (no behavioural change for any real caller — nothing but middleware ever set those headers), plus the matcher fix and a regression test that compiles the real exported matcher with Next's `getMiddlewareMatchers`.
- **Do NOT enable middleware routing itself.** Its `publicPaths` list omits all 10 non-JWT routes (8 `/api/cron/*` using `CRON_SECRET`, `/api/pipeline/import`, `/api/webhooks/retell-callback` HMAC) plus `/api/confirmations/[token]`. Enabling it as-is 401s every cron, the Retell webhook and shipper confirmations. That is Gate 4 work.
- `master` is ~12 commits ahead of `origin/master`. Vercel deploys from the GitHub remote, so the fix only reaches production after a push — which requires the operator's explicit confirmation in-session.
- `MAX_CONCURRENT_CALLS=25` was found live in production 2026-08-26 while all docs describe shadow (`0`). Never re-verified. The agent has NO Vercel/Railway env access; this is an operator task the session must surface, not attempt.
- Railway service `myratms-workers` still runs `DATABASE_URL` as `neondb_owner` (BYPASSRLS) — must rotate to `myra_app`. Operator task (Railway CLI is unauthenticated in sessions).
- `FMCSA_QC_WEBKEY` exists only in git-ignored `MyraTMS/.env.local`. It must be set on Railway AND Vercel (E2-01 gate fails closed without it: every poster-registry miss → human review). The key value is in `.env.local` — NEVER print it, commit it, or echo it into a tracked file.

## Tasks (in order)

1. Inspect `fix-tenant-header-bypass` vs `master`: `git log --oneline master..fix-tenant-header-bypass` and `git diff master...fix-tenant-header-bypass --stat`. Read the changed files fully (expect `MyraTMS/lib/auth.ts`, `MyraTMS/middleware.ts`, a regression test).
2. Rebase/merge the branch onto current `master` (it may be behind; `master` moved through `d7c1f05`). Resolve conflicts conservatively — JWT-derived tenant context must win.
3. Run the relevant tests from `MyraTMS/` against the dev-tests DB branch (`.env.local` already points at it; `vitest.setup.ts` + `lib/db/production-guard.ts` refuse production): at minimum the new regression test, `__tests__` suites touching auth/tenant context, and `pnpm vitest run --no-file-parallelism` on anything flaky. Then `pnpm tsc --noEmit` (build is strict).
4. Merge to `master` with a clear commit message. Stage explicit paths only.
5. Ask the operator to confirm the push; after push, instruct them to verify the Vercel deployment, then verify the fix live: `curl -s -o /dev/null -w "%{http_code}" -H "x-myra-tenant-id: 2" https://<prod-domain>/api/loads` must NOT return 200 with data (expect 401).
6. Present the operator checklist (you cannot do these):
   - [ ] Vercel `myratms` project: confirm `MAX_CONCURRENT_CALLS=0` (watch for trailing whitespace/newline — kill switches are exact-match `.trim().toLowerCase()`, and a trailing newline has silently defeated one before). Same check on Railway.
   - [ ] Railway `myratms-workers`: rotate `DATABASE_URL` to the `myra_app` role connection string (see `docs/architecture/RLS_ROLLOUT.md` and `PRODUCTION_MIGRATION_LOG.md` Entry 2), restart the service, confirm workers boot clean in logs.
   - [ ] Set `FMCSA_QC_WEBKEY` on Railway AND Vercel (value is in `MyraTMS/.env.local` line containing `FMCSA_QC_WEBKEY`).
7. Update docs in the SAME commit as any code change (docs↔code sync rule): root `CLAUDE.md` Known Issues entry for the middleware bypass (mark fix deployed once confirmed), and the memory/tracker references if present.

## Exit criteria (all must be verified, not assumed)

- Forged-header curl returns 401/403 against production.
- `MAX_CONCURRENT_CALLS=0` confirmed by the operator in both dashboards (get them to paste the values).
- Railway on `myra_app`; workers healthy.
- `FMCSA_QC_WEBKEY` present in both platforms.
- All tests green; `master` pushed with operator confirmation.

Report each exit criterion as PASS/BLOCKED-with-reason. Do not report the gate done while any operator item is unconfirmed.
