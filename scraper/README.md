# Myra Scraper (T-04A)

A **bridge layer** — headless browser load-board scanner used while official DAT, Truckstop, 123Loadboard, and Loadlink API access is in onboarding queues. Once any board's official API is provisioned, that adapter retires and the API integration in `MyraTMS/lib/workers/scanner-worker.ts` (Agent 1, T-04) takes over.

**Shelf life:** ~60 days. Audit on **2026-05-30** to determine which boards can be retired.

---

## What it does

```
Load board UI  →  Playwright + stealth  →  RawLoad  →  pipeline_loads
                                                      ↓
                                                  qualify-queue
                                                      ↓
                                              Engine 2 (Qualifier → … → Dispatcher)
```

The scraper is **indistinguishable** from the API-based scanner downstream — it writes to the same `pipeline_loads` table with the same `RawLoad` shape and enqueues the exact same `QualifyJobPayload` to `qualify-queue`. The only marker is `created_by = 'scraper-v1'` (vs `'scanner-csv-v1'` or `'scanner-v1'`).

## Quick start

```bash
# 1. Install
npm install
npx playwright install chromium

# 2. Configure
cp .env.example .env
# fill in DATABASE_URL, REDIS_URL, DAT_USERNAME, DAT_PASSWORD

# 3. Apply DB migration (one-time)
npm run migrate

# 4. Run with debug UI
HEADLESS=false LOG_LEVEL=debug npm run dev
```

## Deployment (Railway)

This is a **separate deployment unit** from MyraTMS. It runs as its own Railway service, sharing only the Neon database and Upstash Redis with the main app. Don't try to deploy this on Vercel — see "Why not Vercel" below.

### Step-by-step

#### 1. Make sure the migration is applied to Neon

The scraper needs `scraper_runs` and `scraper_log` tables. They're additive — they don't touch any existing MyraTMS schema.

```bash
# From the scraper/ directory, with .env populated
npm run migrate

# Verify the tables exist
npx tsx --env-file=.env scripts/verify-tables.mts
```

You should see two tables and six indexes (3 per table, plus the auto-created PK indexes). If the tables already exist (migration is `IF NOT EXISTS` everywhere), the migration succeeds silently — that's intentional, it lets the migration run on every deploy.

#### 2. Push the scraper repo to GitHub (or import the local directory directly into Railway)

Two options:

**Option A — separate Git repo (recommended for production).** Move `M1/scraper/` to its own GitHub repo. Railway pulls from GitHub on every commit.

**Option B — monorepo with a root path.** Keep `scraper/` as a subdirectory of M1. In Railway, set the **service root path** to `scraper/`. Railway only builds and deploys files under that path; the rest of M1 is ignored.

Option B is faster to set up but couples scraper deploys to MyraTMS git activity (every commit triggers a Railway build, even if nothing in `scraper/` changed). Option A is cleaner long-term.

#### 3. Create the Railway project

```bash
# Install Railway CLI if you don't have it
npm i -g @railway/cli
railway login

# Initialize a new project from this directory
cd C:\Users\patri\OneDrive\Desktop\M1\scraper
railway init
# When prompted, choose "Empty Project" and name it "myra-scraper"
```

Or via the web UI:
- Go to https://railway.app/new
- "Deploy from GitHub repo" → pick your scraper repo (Option A) or pick M1 + set root path = `scraper/` (Option B)
- Name the service `myra-scraper`

#### 4. Configure the environment variables

Use the Railway dashboard (`Variables` tab) — values can be plain or marked **secret** (encrypted at rest, hidden from logs). Mark every credential as secret.

**Required:**

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | (same Neon URL as MyraTMS) | postgres://... — use the **pooled** connection string |
| `REDIS_URL` | (same Upstash URL as MyraTMS) | rediss://... — use the **ioredis-compatible** URL, NOT the REST URL |
| `SCRAPER_ENABLED` | `true` | master kill switch — set `false` to halt all polling immediately |
| `TENANT_ID` | `1` | Myra primary tenant |
| `DAT_ENABLED` | `true` | turn on the DAT adapter |
| `DAT_USERNAME` | (your DAT login email) | **secret** |
| `DAT_PASSWORD` | (your DAT password) | **secret** |
| `HEADLESS` | `true` | always true on Railway; only false locally for debugging |

**Recommended:**

| Variable | Value | Notes |
|---|---|---|
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/services/...` | **secret**. Optional but strongly recommended — you'll see captcha/MFA/error alerts |
| `SLACK_ALERT_CHANNEL` | `#myra-scraper` | label only; doesn't route messages |
| `DAT_POLL_INTERVAL_MS` | `300000` | 5 min default. Increase to `600000` (10 min) if DAT throws captchas |
| `DAT_POLL_JITTER_MS` | `60000` | ±60s randomization |
| `DAT_EQUIPMENT` | `dry_van,flatbed,reefer` | comma-separated normalized equipment types |
| `DAT_ORIGIN_PROVINCES` | `ON,AB` | which province codes to search from |
| `DAT_DAYS_FORWARD` | `7` | pickup-date window |

**Optional / advanced:**

| Variable | Use it when |
|---|---|
| `DAT_PROXY_URL=http://user:pass@host:port` | DAT is blocking or throwing captchas — route through a residential proxy |
| `DAT_SEL_RESULT_ROW=...` (and other `DAT_SEL_*`) | DAT changed their UI and you need to override a selector without redeploying code |
| `LOG_LEVEL=debug` | First-day diagnostics |

**Stub boards (leave disabled until their adapters are real):**

```
TRUCKSTOP_ENABLED=false
LOADBOARD123_ENABLED=false
LOADLINK_ENABLED=false
```

#### 5. Configure resources

In Railway settings:
- **Memory:** 512 MB minimum. Bump to 1 GB if you enable 2+ boards or see OOM restarts.
- **Region:** pick the same region as Neon (typically `us-east-1`) and Upstash to minimize latency. Cross-region adds 30–80 ms per query.
- **Restart policy:** "Always" (default).

#### 6. Deploy

Trigger a deploy via:
- `railway up` from CLI, or
- pushing to the connected branch (auto-deploy), or
- "Redeploy" button in the dashboard.

Railway uses the included `Dockerfile`, which is based on `mcr.microsoft.com/playwright:v1.48.0-jammy` — Chromium and all system deps are pre-baked. You don't need a build step that downloads browsers.

Watch the build log for:
- `npm ci` succeeds (ignore `npm warn deprecated` lines — those are transitive)
- `npx tsc -p tsconfig.json` finishes with no errors
- The container starts with `myra-scraper booting` in stdout

#### 7. Smoke-test the first poll

Within 10 minutes of deploy you should see two things:

**A. A row in `scraper_runs`:**

```sql
SELECT source, status, loads_found, loads_inserted, loads_duplicates,
       loads_skipped, duration_ms, completed_at
FROM scraper_runs
WHERE started_at > NOW() - INTERVAL '15 min'
ORDER BY started_at DESC;
```

Expected: at least one row with `status = 'success'` (or `'partial'` if the search returned 0 rows, which is OK on a first run).

**B. Loads appearing in `pipeline_loads`:**

```sql
SELECT load_id, load_board_source, origin_city || ', ' || origin_state AS origin,
       destination_city || ', ' || destination_state AS destination,
       posted_rate, stage, created_by
FROM pipeline_loads
WHERE created_by = 'scraper-v1'
  AND created_at > NOW() - INTERVAL '15 min'
ORDER BY created_at DESC
LIMIT 20;
```

Expected: rows with `created_by = 'scraper-v1'` (this is what distinguishes scraped loads from CSV/API loads).

If the Engine 2 worker host is also running, those loads will start advancing through the pipeline (`scanned → qualified → matched → ...`) automatically. The scraper itself only writes `stage='scanned'` and enqueues `qualify-queue`.

#### 8. Watch Slack on first day

You should see:
- ✅ One `info`-level "Scraper started" message on boot.
- ⚠️ Possibly: `warn` on captcha or MFA — handle per the runbook below.
- ❌ `error` on poll failure — investigate selectors or credentials.

### Why not Vercel

Vercel functions max out at 5 minutes execution time; browser context warm-up (2–4s) plus login (8–15s) plus search/parse (5–10s) is technically under-budget. The real problem is that Vercel can't keep a session warm: every invocation gets a fresh container, so even with a Redis session store you'd pay the warm-up tax (Chromium launch + new context + cookie restore = ~5s) on every poll. A long-running Railway worker pays it once, then runs for weeks. ~$5/mo on Railway vs ~$50/mo on Vercel for equivalent CPU time. Railway is also more honest about what this workload actually is — it's a daemon, not a request handler.

### Verifying you're on Railway, not Vercel

If you find this scraper deployed on Vercel, that is a misconfiguration. The code itself does not assume any platform — it just needs to run a Node 20 process indefinitely with outbound TCP to Neon + Upstash. The included `vercel.json` is intentionally absent, and adding one will not make this work on Vercel.

## Architecture

| Layer | What it does |
|---|---|
| `src/config.ts` | Zod-validated env vars, fail-fast on missing creds |
| `src/observability/` | Pino logger, Slack alerts, `scraper_runs` / `scraper_log` writers |
| `src/browser/` | playwright-extra + stealth, persistent contexts, Redis-backed sessions |
| `src/adapters/` | One `LoadBoardAdapter` per board (DAT real; Truckstop/123LB/Loadlink stubs) |
| `src/pipeline/` | Normalize → dedup → write `pipeline_loads` → enqueue `qualify-queue` |
| `src/scheduler.ts` | Per-board polling intervals with jitter and kill-switch checks |
| `src/index.ts` | Entry point: boots everything, registers SIGTERM handlers |

## Operator runbook

### First 24 hours — what to watch

- Slack `#myra-scraper` for errors/warnings
- `SELECT COUNT(*) FROM scraper_runs WHERE source='dat' AND status='success' AND started_at > NOW() - INTERVAL '1 hour';` should be ≥ 10
- `SELECT COUNT(*) FROM pipeline_loads WHERE created_by='scraper-v1' AND created_at > NOW() - INTERVAL '1 hour';` should be > 0
- The Engine 2 Qualifier worker should be processing — check `agent_jobs` for `qualify-queue` activity

### Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `auth_required` Slack alert | DAT requested MFA | `npm run dat:manual-login` locally, complete MFA, session re-saves |
| 0 loads for 30 min | DAT changed selectors OR captcha | Inspect `/tmp` screenshot, override selectors via env vars, redeploy |
| Process restarts every 5 min | OOM | Bump Railway memory to 1 GB |
| Cross-source duplicates exploding | Wrong `shipperPhone` normalization | Audit `normalizePhone()` against actual DAT phone formats |
| Captcha alerts increasing | Pattern detection — too aggressive polling | Increase `DAT_POLL_INTERVAL_MS` to `600000` (10 min), add `DAT_PROXY_URL` |

### Manual MFA refresh

```bash
HEADLESS=false npm run dat:manual-login
# Browser opens. Complete login + MFA in the visible browser.
# Press Enter in the terminal. Session is written to Redis. Scraper resumes on next poll.
```

## Hard rules

1. **Don't fork the `RawLoad` schema** — must match `MyraTMS/lib/workers/scanner-worker.ts` exactly so loads are indistinguishable downstream.
2. **Don't modify `pipeline_loads`** — additive `scraper_runs` and `scraper_log` tables only.
3. **Don't bypass MFA programmatically** — surface and halt.
4. **Don't skip cross-source dedup** — same shipper + lane + date + equipment within 24h is the same load.
5. **All env vars validated via zod at boot** — no silent defaults for credentials.
6. **Every Slack alert also lands in `scraper_log`** — Slack is for humans, the table is for forensics.

## Cross-references

- **Canonical Scanner spec:** `Engine 2/T04_Scanner_Agent.md`
- **This scraper spec:** `Engine 2/T04A_Headless_Scanner_Fallback.md`
- **Existing CSV ingest path:** `MyraTMS/lib/workers/scanner-worker.ts` `ingestRawLoads()`
- **Engine 2 pipeline:** `MyraTMS/lib/workers/{qualifier,researcher,ranker,compiler,voice,dispatcher,feedback}-worker.ts`
