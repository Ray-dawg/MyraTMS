# Railway worker host: redeploy runbook

**Status (2026-10-09):** not executed. The Railway trial on workspace `e58a63c4-4da2-4e65-8cfa-b6402883ec8a` has expired. `railway status --json` (run from `MyraTMS/`) still reports `latestDeployment = null` and `source = {image: null, repo: null}` on service `myratms-workers` (project `149aa93e-8536-4024-bbf9-5e2fe91f106c`, environment `production`). All 10 deployments are `REMOVED`; the newest is 2026-06-07 01:04 UTC.

This runbook is CLEANUP_REPORT.md items 21, 22 and 24. Run it top to bottom once a plan is active.

## 0. Prerequisite: billing

Railway dashboard → workspace `e58a63c4-…` → Billing → select a plan. Nothing below works until this is done: `railway up` fails with "Your trial has expired".

Ignore the second project named `myratms-workers` (`01bbf6ef-…`). It is an empty duplicate; deleting it is an open question for Patrice.

## 1. Environment (names only; values come from Patrice)

Run from `MyraTMS/`, with the CLI linked to project `149aa93e-…` / service `myratms-workers`.

Add the missing variables:

```bash
railway variables --set "TMS_API_URL=<https://myratms.vercel.app>"   # Dispatcher calls TMS routes with a service token
railway variables --set "FMCSA_QC_WEBKEY=<value>"                     # E2-01 gate: without it, registry misses fail closed to review
railway variables --set "NEXT_PUBLIC_APP_URL=<https://myratms.vercel.app>"
railway variables --set "NEXT_PUBLIC_TRACKING_URL=<https://v0-enterprise-logistic-one-pager.vercel.app>"
```

Remove the retired variable (T-19 moved the margin floor to `lib/tenants/margin-floor.ts`):

```bash
railway variables --remove AUTO_BOOK_PROFIT_THRESHOLD   # or delete it in the dashboard if this CLI version lacks --remove
```

Rotate `DATABASE_URL` from `neondb_owner` to the NOBYPASSRLS app role `myra_app`. This is multi-tenant M3; until it is done, RLS is a no-op for every worker path. Use the same pooled `myra_app` connection string Vercel production already uses:

```bash
railway variables --set "DATABASE_URL=<myra_app pooled connection string>"
```

Leave these exactly as they are. The workers must boot idle:

| Variable | Required value |
|---|---|
| `PIPELINE_ENABLED` | `true` |
| `SCANNER_ENABLED` | `false` |
| `MAX_CONCURRENT_CALLS` | `0` (shadow mode, no shipper calls) |
| `SHIPPER_DIRECT_GATE_ENABLED` / `SHIPPER_DIRECT_GATE_MODE` | `true` / `shadow` |
| `CARRIER_CALLS_ENABLED`, `CARRIER_AUTO_ASSIGN_ENABLED`, `SHIPPER_CONFIRMATION_ENABLED`, `INBOUND_EMAIL_POLLING_ENABLED` | **unset** |

Read the values back after setting them. Kill switches are exact-match after `.trim().toLowerCase()`, and a trailing newline has silently defeated one before. This command prints names only:

```bash
railway variables --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).sort().join("\n")))'
```

## 2. Redeploy from a clean checkout of `origin/master`

`railway up` uploads the local directory, not git, so never run it from a working tree with local changes:

```bash
git fetch origin
git worktree add ../myra-deploy origin/master
cd ../myra-deploy/MyraTMS
railway link        # select project 149aa93e-… / environment production / service myratms-workers
railway up --service myratms-workers
cd ../.. && git worktree remove ../myra-deploy
```

**Preferred, so the host can't silently drift again:** Railway dashboard → service `myratms-workers` → Settings → Source → connect GitHub repo `Ray-dawg/MyraTMS`, root directory `MyraTMS`, branch `master`. Every push to `master` then redeploys the workers. `MyraTMS/railway.json` already defines the NIXPACKS build and `pnpm tsx scripts/run-workers.ts` start command.

## 3. Verify

1. `railway deployment list` shows a new deployment with status `SUCCESS`.
2. `railway logs` shows all 10 workers booting: qualifier, researcher, ranker, compiler, voice, dispatcher, feedback, shipper-confirmation, carrier-brief-compiler, carrier-voice. It must show no unhandled errors and no call attempts (`MAX_CONCURRENT_CALLS=0`).
3. Trigger the health cron by hand and confirm it is green: `curl -H "Authorization: Bearer $CRON_SECRET" https://myratms.vercel.app/api/cron/pipeline-health`.
4. Record the deployment id, commit SHA and date in `Engine 2/docs/superpowers/plans/completion.md` (re-check roadmap item A.3.2), `docs/next-steps/ENGINE2.md`, `Engine 2/CLAUDE.md` and root `CLAUDE.md` (Deployments table and Known Issues), in the same commit.

## 4. First post-revival task: liveness monitor (roadmap D.1.3)

The worker host was gone for four months because nothing could observe it. Before anything else is enabled:

- `scripts/run-workers.ts` writes a heartbeat key to Redis every `WORKER_HEARTBEAT_MS` (the env name is already read in `lib/workers/`), with a TTL a few times that interval.
- `lib/pipeline/health-checks.ts` (run by the daily `pipeline-health` cron) raises an `exceptions` row / alert when the key is missing.
- Add a test that fails when the heartbeat is absent.

## Not part of this runbook (intentionally parked, decision D3)

- **Scraper Railway service:** not created; DAT credentials and the ToS question remain open.
- **IMAP poller:** no host and no credentials.
