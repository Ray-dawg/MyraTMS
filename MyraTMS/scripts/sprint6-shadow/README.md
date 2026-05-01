# Sprint 6 — Shadow Mode + First 10 Live Calls

End-to-end runbook. Two phases:

| Phase | What it proves | Risk | Duration |
|---|---|---|---|
| **6A — Shadow mode** | Pipeline drains 50–100 synthetic loads cleanly. Targets: 20-30% qualification rate, 1–3 matches per qualified load, ≥99% brief validation. | None — no calls placed | ~30 min |
| **6B — First 10 live calls** | Real Retell calls against real shipper phones, listened-to live, outcomes logged. | High — real phones, real perception | 1–4 hrs (with iteration) |

Both phases share the same pipeline code that's been live since Sprint 5. **No pipeline code changes for Sprint 6.** The work here is observability, safety gates, and synthetic data generation.

---

## Files in this directory

| File | Purpose |
|---|---|
| `01-preflight.ts` | Verifies infra + safe env state before either phase |
| `02-generate-shadow-loads.ts` | Generates 50-100 synthetic loads (TEST_ prefix, fictional phones) |
| `03-watch-pipeline.sql` | Live-monitoring SQL queries |
| `04-shadow-metrics.ts` | Post-run evaluator — PASS/FAIL against success criteria |
| `05-live-call-preflight.ts` | Hard gate before flipping MAX_CONCURRENT_CALLS=0→1 |
| `06-cleanup.ts` | Drains TEST_ loads after shadow runs (idempotent) |
| `07-emergency-stop.ts` | Single-command halt of all pipeline activity |

---

## Phase 6A — Shadow Mode (do this FIRST)

### Pre-conditions

- All Engine 2 sprints (0 through 6.5) committed and deployed
- Worker host running (Railway or wherever you've deployed `MyraTMS/scripts/run-workers.ts`)
- Vercel cron jobs enabled (`pipeline-health`, `feedback-aggregation`, `pipeline-scan`)
- `loadboard_sources.dat.ingest_method` = `'scrape'` OR `'disabled'` — **NOT** `'api'` (we don't want extra DAT rows mixing into the shadow run)
- All `*_ENABLED=false` in Railway scraper env (we want a controlled synthetic dataset, not live DAT data)

### Required env vars (in MyraTMS Vercel env)

```
PIPELINE_ENABLED=true          # workers will process jobs
SCANNER_ENABLED=false          # cron pipeline-scan stays a noop (no API ingest)
MAX_CONCURRENT_CALLS=0         # SHADOW MODE — Voice worker skips calls
AUTO_BOOK_PROFIT_THRESHOLD=999999   # belt and suspenders — auto-book disabled
JWT_SECRET=<existing>
DATABASE_URL=<existing>
KV_REST_API_URL=<existing>
KV_REST_API_TOKEN=<existing>
UPSTASH_REDIS_URL=<existing>   # ioredis-compatible URL
PIPELINE_IMPORT_TOKEN=<random>
CRON_SECRET=<existing>
```

### Step 1 — Pre-flight

```bash
cd MyraTMS
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/01-preflight.ts
```

Expected: `PRE-FLIGHT: OK ✓` and a green summary. If anything is RED, fix before proceeding.

### Step 2 — Drain any old TEST_ loads

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts
```

Expected: deletes any TEST_ rows from prior runs. Safe to run on a fresh DB (no-op).

### Step 3 — Generate synthetic loads

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/02-generate-shadow-loads.ts --count=75
```

Default count is 50. The generator submits via `POST /api/pipeline/import` (uses `PIPELINE_IMPORT_TOKEN` from env). Output is a summary of received/inserted/duplicates and the time it took.

### Step 4 — Watch the pipeline drain (live)

In another terminal, open `03-watch-pipeline.sql` and run the queries against Neon. Run periodically (every 30s for ~10 min). You should see:

- Stage distribution shift: `scanned` → `qualified`/`disqualified` → `matched` → `briefed`
- `agent_calls` table NOT growing (shadow mode — no calls placed)
- `agent_jobs` table populated with success rows for qualifier/researcher/ranker/compiler/voice (voice rows show `outcome='shadow_skip'`)

### Step 5 — Run metrics

After ~10 min the pipeline should be drained. Run:

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/04-shadow-metrics.ts
```

Expected:
```
PASS  Qualification rate: 27% (target 20-30%)
PASS  Avg match count per qualified: 2.1 (target 1-3)
PASS  Brief validation pass: 100% (target ≥99%)
PASS  Voice agent shadow skips: 18 (target = number of briefed loads)
PASS  No agent_jobs failures
SHADOW MODE: GREEN — ready for Phase 6B
```

If any metric is RED, investigate before proceeding to live calls. Common issues:

| Symptom | Likely cause | Fix |
|---|---|---|
| 0% qualification | Carrier table has no active carriers / no equipment matches | Run `SELECT COUNT(*) FROM carriers WHERE authority_status='active'` |
| 100% qualification | Margin filter not firing (check posted_rate distribution) | Inspect `Engine 2/lib/quoting/rates/benchmark.ts` |
| 0 matches per qualified load | `lib/matching/runMatchingEngine` returning empty | Verify carriers have lane history |
| Brief validation < 99% | Calling-hours or DNC compliance failing on synthetic data | Inspect `negotiation_briefs.brief.validationErrors` |

### Step 6 — Cleanup

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts
```

---

## Phase 6B — First 10 Live Calls

**STOP. Do not start this phase until Phase 6A's metrics are GREEN and you have:**
1. ✅ Real DAT credentials OR a curated list of 10–20 consenting test shippers (real phone numbers, with prior verbal consent — CASL/TCPA requires it)
2. ✅ Retell account active with real agent IDs configured per persona (assertive/friendly/analytical)
3. ✅ Public webhook URL deployed (`https://your-app.vercel.app/api/webhooks/retell-callback`)
4. ✅ `RETELL_WEBHOOK_SECRET` set in both Retell dashboard AND Vercel env

### Required env var changes

```
MAX_CONCURRENT_CALLS=1          # ← KEY CHANGE: 0 (shadow) → 1 (one live call at a time)
PIPELINE_ENABLED=true
SCANNER_ENABLED=false           # still no API/scrape ingest — feeding loads manually
AUTO_BOOK_PROFIT_THRESHOLD=999999  # still off — review every booking manually
RETELL_API_KEY=<from Retell dashboard>
RETELL_WEBHOOK_SECRET=<random shared with Retell webhook config>
ANTHROPIC_API_KEY=<for webhook outcome parser fallback>
```

### Step 1 — Live-call pre-flight

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/05-live-call-preflight.ts
```

This is an aggressive gate. It will refuse to greenlight if:
- Any of the above env vars are missing
- Any persona row has a placeholder Retell agent ID (e.g. `agent_xxx`)
- Webhook URL doesn't return HTTP 401 for an unsigned request
- DNC list lacks the operator's own phone (defensive — you don't want internal numbers called)
- Calling hours allow calls right now (sanity check; you should be at the keyboard)

Run only after fixing any RED items.

### Step 2 — Prepare the 10-load batch

Don't generate fake — use real consenting shippers:

```bash
# Edit scripts/sprint6-shadow/test-shippers.csv (gitignored — operator builds this)
# Format:
#   loadId,equipment,origin,destination,pickupDate,postedRate,shipperCompany,shipperContactName,shipperPhone,shipperEmail
# Example:
#   LIVE-TEST-001,Dry Van,"Toronto, ON","Sudbury, ON",2026-05-04,2400,Northern Mine Supply,Jean-Marc T,+17055551861,jm@nmsco.ca

curl -X POST http://localhost:3000/api/pipeline/import \
  -H "Authorization: Bearer $PIPELINE_IMPORT_TOKEN" \
  -H "Content-Type: text/csv" \
  --data-binary @scripts/sprint6-shadow/test-shippers.csv
```

(or use the existing UI at Settings → Import → Loads)

### Step 3 — Watch live in Retell dashboard

Open Retell dashboard's "Live Calls" view. Within ~5 min of import, you should see calls appear one at a time (cap=1). Listen to each.

In a separate terminal, watch DB activity:

```sql
-- Calls in flight or recently completed
SELECT call_id, persona, outcome, agreed_rate, profit, sentiment, created_at
FROM agent_calls
WHERE call_id LIKE 'LIVE-TEST-%' OR call_initiated_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

### Step 4 — Verify outcomes

For each booked outcome:
- ✅ Confirm `loads.id` row exists in TMS (Dispatcher ran)
- ✅ Confirm tracking link sent to shipper email (check sent mail)
- ✅ Confirm `agent_calls.outcome` matches what you heard

For each not_booked / callback / voicemail:
- Review the transcript in `agent_calls.transcript`
- Note any prompt iteration the persona needs

### Step 5 — Iterate prompts (if needed)

Prompts live in **Retell's dashboard**, not in this codebase. Update each persona's prompt template based on what you heard, then run another batch.

### Step 6 — When you're confident

Bump `MAX_CONCURRENT_CALLS` upward (3, 5, 10...) and you're moving from "first 10" into normal operation.

---

## Emergency stop

If anything goes sideways:

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/07-emergency-stop.ts
```

Or manually in Vercel dashboard:
1. Set `PIPELINE_ENABLED=false`
2. Redeploy (env-var changes don't apply until next deploy)
3. In-flight calls in Retell run to completion (cannot be aborted mid-call), but no new ones are placed.

To stop calls AT THE SOURCE, also pause `MAX_CONCURRENT_CALLS=0`.

---

## Compliance reminders

- **CASL** (Canadian) requires express consent for commercial calls. Don't dial anyone who hasn't opted in.
- **TCPA** (US) requires similar; the DNC list is the legal floor.
- All calls are logged to `agent_calls` and `compliance_audit` for regulatory defense.
- The `consent_log` table records every consent affirmation collected during a call — keep it.
