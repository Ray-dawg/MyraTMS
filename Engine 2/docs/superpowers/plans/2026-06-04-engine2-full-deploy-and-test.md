# Engine 2 — Full Deployment & Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take Engine 2 from "code complete on master + MyraTMS on Vercel" to "all 7 workers running on Railway, a full shadow drain proven GREEN, and the first 10 live Retell calls placed end-to-end."

**Architecture:** MyraTMS API + crons already run on Vercel (project `myratms`). This plan stands up the missing piece — the persistent BullMQ worker host (`scripts/run-workers.ts`) on a new Railway service sharing the same Neon DB + Upstash Redis — then drives the existing `scripts/sprint6-shadow/` operator scripts through Phase 6A (shadow, zero calls) and Phase 6B (10 live calls). No new pipeline features; this is deploy + wire + validate.

**Tech Stack:** Vercel (Next.js 16 API/crons), Railway (Node 24 worker container via `pnpm tsx`), Neon Postgres, Upstash Redis (ioredis/BullMQ), Anthropic SDK, Retell voice.

**Known starting state (verified 2026-06-04):**
- ✅ MyraTMS deployed to Vercel production, project `myratms` (`prj_gb8g00RfVeJeoujrLVPhchm8maN4`, team `team_Ps9WgxfAW909bMSTjui9jC2m`)
- ✅ `/api/health` route + `railway.json` committed (startCommand `pnpm tsx scripts/run-workers.ts`)
- ✅ 200 prospect + 6 active carriers seeded (`carrier_status`), Ranker returns matches
- ✅ 11 pipeline tables applied to Neon; 3 personas seeded with live Retell agent IDs
- ✅ Retell account: API key + webhook secret + 3 agents (assertive/friendly/analytical) in hand
- ✅ Anthropic API key in hand
- ❓ Vercel production **Engine 2 env vars** unverified — Phase 0 audits them
- ❌ No worker host deployed yet — **this is the gap that stopped the last attempt** (Railway)

**Operator decisions locked (2026-06-04):** Create Railway now ($5/mo) · Shadow drain → then 10 live calls · Anthropic key in hand · Verify Vercel env first.

**Conventions for this plan**
- All `pnpm` commands run from `C:\Users\patri\OneDrive\Desktop\M1\MyraTMS` (NOT the `Engine 2/` spec dir) unless stated.
- "Operator action" steps are things only Patrice can do (create accounts, paste secrets into dashboards). They're called out explicitly — an agent executing this plan must STOP and hand off at those steps.
- Secrets never get committed or echoed in full. Use the dashboards / `vercel env` / `railway variables`.
- After each phase, tick the matching box in `Engine 2/docs/superpowers/plans/completion.md` and append a Change Log line (per the standing "keep completion.md in sync, do not batch" rule).

---

## Phase 0 — Secret Inventory & Vercel Env Audit (verify, don't assume)

Goal: prove every secret the pipeline needs exists and is correct, in all three places it must live (local `.env.local`, Vercel prod, Railway). Catch the carrier-casing bug. No deploys yet.

The full env contract (from `.env.example`):

| Var | Used by | Phase-0 target value |
|---|---|---|
| `DATABASE_URL` | all | Neon prod conn string |
| `JWT_SECRET` | API + service-token | same secret in Vercel + Railway |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | cache (`lib/redis.ts`) | Upstash REST tab |
| `UPSTASH_REDIS_URL` | BullMQ (`redis-bullmq.ts`) | Upstash ioredis tab (`rediss://`) |
| `ANTHROPIC_API_KEY` | Researcher/Compiler/parser | real key |
| `RETELL_API_KEY` / `RETELL_WEBHOOK_SECRET` | Voice + webhook | real |
| `RETELL_WEBHOOK_URL` / `RETELL_FUNCTION_URL` | Retell dashboard wiring | prod URLs (set in Phase 3) |
| `PIPELINE_IMPORT_TOKEN` | `POST /api/pipeline/import` | strong random |
| `CRON_SECRET` | `/api/cron/*` | strong random |
| `PIPELINE_ENABLED` | master kill switch | `true` (workers process) |
| `SCANNER_ENABLED` | CSV/API ingest | `false` (we ingest manually) |
| `MAX_CONCURRENT_CALLS` | Voice shadow gate | `0` until Phase 4 |
| `AUTO_BOOK_PROFIT_THRESHOLD` | dispatcher auto-book | `999999` (off) |
| `FMCSA_API_KEY` | carrier verify (optional) | optional |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | maps (optional) | optional |

### Task 0.1: Confirm local `.env.local` has every required var

**Files:**
- Read: `MyraTMS/.env.local` (do not print secret values to the chat)

- [ ] **Step 1: List which required keys are present locally**

Run:
```bash
cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS"
node -e "require('dotenv').config({path:'.env.local'}); const need=['DATABASE_URL','JWT_SECRET','KV_REST_API_URL','KV_REST_API_TOKEN','UPSTASH_REDIS_URL','ANTHROPIC_API_KEY','RETELL_API_KEY','RETELL_WEBHOOK_SECRET','PIPELINE_IMPORT_TOKEN','CRON_SECRET','PIPELINE_ENABLED','MAX_CONCURRENT_CALLS','AUTO_BOOK_PROFIT_THRESHOLD']; for(const k of need){console.log((process.env[k]?'SET   ':'MISSING'), k);}"
```
Expected: every line `SET`. Any `MISSING` → fill it in `.env.local` before continuing (get the value from the matching dashboard).

- [ ] **Step 2: Confirm shadow-safe defaults locally**

Run:
```bash
node -e "require('dotenv').config({path:'.env.local'}); console.log('PIPELINE_ENABLED=',process.env.PIPELINE_ENABLED,'MAX_CONCURRENT_CALLS=',process.env.MAX_CONCURRENT_CALLS,'AUTO_BOOK=',process.env.AUTO_BOOK_PROFIT_THRESHOLD);"
```
Expected: `PIPELINE_ENABLED= true MAX_CONCURRENT_CALLS= 0 AUTO_BOOK= 999999`. If `MAX_CONCURRENT_CALLS` is not `0`, set it to `0` now (shadow safety).

### Task 0.2: Verify the Anthropic key actually works

- [ ] **Step 1: One-shot live ping to the Anthropic API**

Run:
```bash
node -e "require('dotenv').config({path:'.env.local'}); fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:8,messages:[{role:'user',content:'ping'}]})}).then(r=>r.json()).then(j=>console.log(j.error?('FAIL '+JSON.stringify(j.error)):'PASS model='+j.model)).catch(e=>console.log('FAIL',e.message));"
```
Expected: `PASS model=claude-haiku-4-5-...`. If `FAIL authentication_error` → the key is wrong/expired; replace it before Phase 4 (Researcher Source-5 falls back gracefully in shadow mode, but the live-call transcript parser needs it).

### Task 0.3: Audit Vercel production env vars

**Files:**
- Vercel project `myratms` (already linked via `MyraTMS/.vercel/project.json`)

- [ ] **Step 1: List the production env keys Vercel currently holds**

Run:
```bash
cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS"
npx vercel env ls production
```
Expected: a table of keys. (If it prompts to log in: **operator action** — run `npx vercel login` in a `!` shell first.)

- [ ] **Step 2: Diff against the required set**

Compare the printed keys against the table in this phase's intro. Write down which of these are **absent** from Vercel production: `ANTHROPIC_API_KEY`, `RETELL_API_KEY`, `RETELL_WEBHOOK_SECRET`, `UPSTASH_REDIS_URL`, `PIPELINE_IMPORT_TOKEN`, `CRON_SECRET`, `PIPELINE_ENABLED`, `SCANNER_ENABLED`, `MAX_CONCURRENT_CALLS`, `AUTO_BOOK_PROFIT_THRESHOLD`.

### Task 0.4: Fill Vercel env gaps (only the missing ones from 0.3)

- [ ] **Step 1: Add each missing secret to Vercel production**

For each missing key (example shows two — repeat per gap). **Operator action** when the value is a secret:
```bash
# Secrets — paste value when prompted, scope = Production:
printf '%s' "<value>" | npx vercel env add ANTHROPIC_API_KEY production
printf '%s' "<value>" | npx vercel env add RETELL_API_KEY production
printf '%s' "<value>" | npx vercel env add RETELL_WEBHOOK_SECRET production
printf '%s' "<rediss-url>" | npx vercel env add UPSTASH_REDIS_URL production
printf '%s' "<random-32+>" | npx vercel env add PIPELINE_IMPORT_TOKEN production
printf '%s' "<random-32+>" | npx vercel env add CRON_SECRET production
```

- [ ] **Step 2: Set the non-secret kill-switch vars to safe values**

```bash
printf 'true'    | npx vercel env add PIPELINE_ENABLED production
printf 'false'   | npx vercel env add SCANNER_ENABLED production
printf '0'       | npx vercel env add MAX_CONCURRENT_CALLS production
printf '999999'  | npx vercel env add AUTO_BOOK_PROFIT_THRESHOLD production
```
Note: if a key already exists, `vercel env add` errors — use `npx vercel env rm <KEY> production` first, then re-add. Generate randoms with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

- [ ] **Step 3: Redeploy so the new env takes effect**

```bash
npx vercel --prod
```
Expected: a production deployment URL. Crons re-register from `vercel.json` automatically.

- [ ] **Step 4: Commit nothing (env only) — note the deploy URL**

Record the production URL (e.g. `https://myratms.vercel.app` or custom domain) — Phase 3 needs it for the Retell webhook.

### Task 0.5: Verify production DB state via the live API

- [ ] **Step 1: Health endpoint is green in production**

Run (replace with your prod URL):
```bash
curl -s https://<prod-domain>/api/health
```
Expected: HTTP 200 with a JSON body indicating DB + Redis reachable. If 500 → the deploy can't reach Neon/Upstash; fix env before continuing.

- [ ] **Step 2: Confirm personas have real Retell agent IDs (not placeholders)**

Run:
```bash
cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS"
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); const r=await sql\`SELECT persona_name, retell_agent_id_en, is_active FROM personas ORDER BY persona_name\`; console.table(r);"
```
Expected: 3 rows, each `retell_agent_id_en` starting `agent_` (a real ID), `is_active=true`. If any are placeholders (`agent_x...`, null) → they're fine for shadow mode but become a Phase 3 fix.

---

## Phase 1 — Railway Worker Host Deploy

Goal: the 7 BullMQ workers run as a persistent Railway service in **shadow mode** (`MAX_CONCURRENT_CALLS=0`), sharing the same Neon + Upstash as Vercel. This is the gap that blocked the last attempt.

### Task 1.1: Create the Railway project (OPERATOR ACTION)

- [ ] **Step 1: Sign up + create project**

**Operator action (Patrice):**
1. Go to https://railway.app → sign up (GitHub login is easiest; $5/mo Hobby plan).
2. **New Project → Deploy from GitHub repo** → select the MyraTMS repo.
3. In **Settings → Root Directory**, set it to `MyraTMS` (the repo root contains `Engine 2/`, `MyraTMS/`, `scraper/` — Railway must build from `MyraTMS/` where `railway.json` + `package.json` live).
4. Confirm Railway picked up `railway.json` (Build = Nixpacks, Start = `pnpm tsx scripts/run-workers.ts`).
5. Do **not** deploy yet — env vars come first (Task 1.2). If it auto-deploys and crashes on missing env, that's expected; it'll restart after 1.2.

- [ ] **Step 2: Hand the project to the agent**

**Operator action:** install the Railway CLI and link, OR provide a project token:
```bash
npm i -g @railway/cli
railway login          # opens browser — operator action
railway link           # pick the new project/service
```
Expected: `railway status` prints the linked project + service.

### Task 1.2: Set Railway service env vars (mirror Vercel, shadow-safe)

- [ ] **Step 1: Push every worker-needed var into Railway**

The worker host needs the same secrets as Vercel **except** the `NEXT_PUBLIC_*` browser vars and Blob token. Set them (operator pastes secret values):
```bash
railway variables --set "DATABASE_URL=<neon>" \
  --set "UPSTASH_REDIS_URL=<rediss-url>" \
  --set "KV_REST_API_URL=<upstash-rest-url>" \
  --set "KV_REST_API_TOKEN=<upstash-rest-token>" \
  --set "JWT_SECRET=<same-as-vercel>" \
  --set "ANTHROPIC_API_KEY=<key>" \
  --set "RETELL_API_KEY=<key>" \
  --set "RETELL_WEBHOOK_SECRET=<secret>" \
  --set "PIPELINE_IMPORT_TOKEN=<same-as-vercel>" \
  --set "CRON_SECRET=<same-as-vercel>" \
  --set "PIPELINE_ENABLED=true" \
  --set "SCANNER_ENABLED=false" \
  --set "MAX_CONCURRENT_CALLS=0" \
  --set "AUTO_BOOK_PROFIT_THRESHOLD=999999"
```
**Critical:** `JWT_SECRET` MUST be byte-identical to Vercel's — the Dispatcher mints a service-token JWT on Railway that the Vercel API routes verify. A mismatch makes every dispatch 401.

- [ ] **Step 2: Confirm the variables landed**

```bash
railway variables
```
Expected: all 14 keys listed, `MAX_CONCURRENT_CALLS=0`, `PIPELINE_ENABLED=true`.

### Task 1.3: Deploy and confirm the worker pool boots

- [ ] **Step 1: Trigger a deploy**

```bash
cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS"
railway up
```
Expected: build succeeds (Nixpacks installs via `pnpm install --frozen-lockfile`), container starts.

- [ ] **Step 2: Tail logs and confirm all workers start**

```bash
railway logs
```
Expected lines (from `run-workers.ts`):
```
[worker-host] Starting Engine 2 worker pool
[worker-host] ... qualifier ... researcher ... ranker ... compiler ... voice ... dispatcher ... feedback ... started
```
No `ECONNREFUSED` / `WRONGPASS` (those = bad `UPSTASH_REDIS_URL`). No `Date.now` / module-not-found crashes. The process should stay up (restartPolicy ON_FAILURE would loop if it's crashing — watch for repeated "Starting" lines).

- [ ] **Step 3: Confirm worker↔Redis↔DB round-trip with a probe job**

From local (enqueues into the same Upstash the Railway workers consume):
```bash
pnpm tsx --env-file=.env.local scripts/test-queue-connection.ts
```
Expected: `PING/PONG ✓`, probe job round-trips. (This proves the shared Redis path the Railway workers use.)

### Task 1.4: Phase 1 checkpoint + tracker update

- [ ] **Step 1: Verify no jobs are stuck**

```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); const r=await sql\`SELECT status, COUNT(*)::int FROM agent_jobs GROUP BY status\`; console.table(r);"
```
Expected: empty or only old rows — no growing `failed` count.

- [ ] **Step 2: Tick completion.md A.3.2 + Change Log**

Edit `Engine 2/docs/superpowers/plans/completion.md`: mark `A.3.2` done, append:
`- 2026-06-04 — Railway worker host deployed (shadow mode, MAX_CONCURRENT_CALLS=0). All 7 workers boot, share prod Neon+Upstash, probe job round-trips.`

```bash
git add "Engine 2/docs/superpowers/plans/completion.md"
git commit -m "Engine 2 A.3.2: deploy worker host to Railway (shadow mode)"
```

---

## Phase 2 — Shadow Drain (Phase 6A, zero real calls)

Goal: 75 synthetic loads flow scanned → qualified → researched+matched → briefed, `04-shadow-metrics.ts` prints GREEN, and **zero** Retell calls fire. First, fix the carrier-casing bug that would falsely FAIL preflight.

### Task 2.1: Fix the `authority_status` casing bug in preflight

**Files:**
- Modify: `MyraTMS/scripts/sprint6-shadow/01-preflight.ts` (the `checkCarriers()` query)
- Reference: `MyraTMS/lib/matching/filters.ts` (canonical: uses `'Active'` capitalized)

- [ ] **Step 1: Confirm the bug exists**

Run the current preflight carrier check in isolation:
```bash
cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS"
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); const lower=(await sql\`SELECT COUNT(*)::int c FROM carriers WHERE authority_status='active' AND (insurance_expiry IS NULL OR insurance_expiry>NOW())\`)[0].c; const upper=(await sql\`SELECT COUNT(*)::int c FROM carriers WHERE authority_status='Active' AND (insurance_expiry IS NULL OR insurance_expiry>NOW())\`)[0].c; console.log('lowercase active =',lower,' | Capitalized Active =',upper);"
```
Expected: `lowercase active = 0 | Capitalized Active = 206` (or similar). Confirms the script's `'active'` literal finds nothing.

- [ ] **Step 2: Patch the query to match the real data + `filters.ts`**

In `scripts/sprint6-shadow/01-preflight.ts`, inside `checkCarriers()`, change the WHERE clause from `authority_status = 'active'` to `authority_status = 'Active'`:
```ts
  const rows = (await sql`
    SELECT COUNT(*)::int AS active
    FROM carriers
    WHERE authority_status = 'Active'
      AND (insurance_expiry IS NULL OR insurance_expiry > NOW())
  `) as Array<{ active: number }>;
```

- [ ] **Step 3: Commit the fix**

```bash
git add scripts/sprint6-shadow/01-preflight.ts
git commit -m "Engine 2 6A: fix preflight carrier check casing ('active'->'Active') to match filters.ts + FMCSA seed"
```

### Task 2.2: Run preflight against production state — all green

- [ ] **Step 1: Run the full preflight**

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/01-preflight.ts
echo "EXIT: $?"
```
Expected: `EXIT: 0`. Every check `PASS` (personas may `WARN` if any placeholder IDs — acceptable for 6A). Specifically:
- `env.PIPELINE_ENABLED PASS`, `env.MAX_CONCURRENT_CALLS PASS` (=0)
- `db.schema PASS` (11 pipeline tables)
- `db.carriers PASS` (~206 active) ← was failing before Task 2.1
- `db.personas` PASS or WARN

- [ ] **Step 2: If any FAIL, resolve before draining**

A non-zero exit lists each FAIL with a reason. Common: a missing env var (go back to Phase 0), or leftover TEST_ data (run cleanup, Task 2.3).

### Task 2.3: Drain any prior TEST_ data

- [ ] **Step 1: Clean leftover synthetic rows**

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts
```
Expected: reports N TEST_ rows removed (or 0 on a fresh DB). Idempotent.

### Task 2.4: Generate 75 synthetic loads

- [ ] **Step 1: Inject the shadow batch**

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/02-generate-shadow-loads.ts --count=75
```
Expected: 75 loads inserted into `pipeline_loads` with TEST_ markers + fictional NANP phone numbers, enqueued to `qualify-queue`. The Railway workers begin processing within seconds.

### Task 2.5: Watch the drain

- [ ] **Step 1: Observe stage progression (run repeatedly for ~10 min)**

The watch file is SQL, not a script. Run its stage-distribution query directly:
```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); const r=await sql\`SELECT stage, COUNT(*)::int FROM pipeline_loads WHERE created_by LIKE 'shadow%' OR load_id LIKE 'TEST_%' GROUP BY stage ORDER BY 1\`; console.table(r);"
```
Expected over ~10 min: loads move `scanned → qualified → matched → briefed`, with a chunk `disqualified` (the generator deliberately mixes ~25% non-qualifying loads). Terminal state: most in `briefed`, none stuck in `scanned`/`qualified` after the drain settles.

- [ ] **Step 2: Confirm zero calls fired**

```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); const r=(await sql\`SELECT COUNT(*)::int c FROM agent_calls WHERE created_at > NOW() - INTERVAL '1 hour'\`)[0].c; console.log('calls in last hour =', c, c===0?'(GOOD — shadow)':'(BAD — investigate, MAX_CONCURRENT_CALLS should be 0)');"
```
Expected: `calls in last hour = 0 (GOOD — shadow)`.

### Task 2.6: Run the metrics gate

- [ ] **Step 1: Evaluate PASS/FAIL**

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/04-shadow-metrics.ts
echo "EXIT: $?"
```
Expected: `SHADOW MODE: GREEN ✓`, `EXIT: 0`. Criteria checked: qualification rate 20-30%, 1-3 matches per qualified load, ≥99% brief validation, 0 real calls. If RED, the output names which criterion failed — fix and re-drain (cleanup → generate → metrics).

- [ ] **Step 2: Clean up the shadow data**

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts
```

### Task 2.7: Phase 2 checkpoint + tracker update

- [ ] **Step 1: Tick completion.md A.4.1–A.4.4 + Change Log**

Mark `A.4.1`, `A.4.2`, `A.4.3`, `A.4.4` done. Append:
`- 2026-06-04 — Phase 6A shadow drain GREEN on production infra (Railway workers + prod Neon/Upstash). 75 loads, ~25% disqualified, briefs validated, 0 calls. Fixed preflight carrier-casing bug.`

```bash
git add "Engine 2/docs/superpowers/plans/completion.md"
git commit -m "Engine 2 A.4: Phase 6A shadow drain GREEN"
```

---

## Phase 3 — Live-Call Readiness (gates Phase 6B)

Goal: everything required to legally and technically place a real call is wired and verified — Retell agent IDs, production webhook, DNC list, and a small consenting test-shipper batch. Nothing here places a call yet.

### Task 3.1: Confirm/insert real Retell agent IDs in `personas`

- [ ] **Step 1: Check current values**

```bash
cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS"
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); console.table(await sql\`SELECT persona_name, retell_agent_id_en, from_number, is_active FROM personas ORDER BY persona_name\`);"
```
Expected: 3 rows with real `agent_...` IDs (from Retell dashboard → Agents) and a `from_number` per persona. If placeholders remain:

- [ ] **Step 2 (only if placeholders): Update with real IDs (OPERATOR provides IDs)**

```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); await sql\`UPDATE personas SET retell_agent_id_en='agent_<ASSERTIVE_ID>', from_number='<+1...>' WHERE persona_name='assertive'\`; await sql\`UPDATE personas SET retell_agent_id_en='agent_<FRIENDLY_ID>', from_number='<+1...>' WHERE persona_name='friendly'\`; await sql\`UPDATE personas SET retell_agent_id_en='agent_<ANALYTICAL_ID>', from_number='<+1...>' WHERE persona_name='analytical'\`; console.log('updated');"
```

### Task 3.2: Wire the production Retell webhook + verify signature

- [ ] **Step 1: Set webhook URL in Retell dashboard (OPERATOR ACTION)**

**Operator action:** Retell dashboard → each agent (or account-level) webhook settings:
- Webhook URL = `https://<prod-domain>/api/webhooks/retell-callback`
- Signature secret = the exact `RETELL_WEBHOOK_SECRET` value in Vercel/Railway.

- [ ] **Step 2: Set the URL vars in Vercel + Railway**

```bash
printf 'https://<prod-domain>/api/webhooks/retell-callback' | npx vercel env add RETELL_WEBHOOK_URL production
railway variables --set "RETELL_WEBHOOK_URL=https://<prod-domain>/api/webhooks/retell-callback"
```
(If `RETELL_FUNCTION_URL` is used by your gatekeeper custom tools, set it the same way to its route.)

- [ ] **Step 3: Confirm the webhook route is publicly reachable + rejects unsigned posts**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<prod-domain>/api/webhooks/retell-callback -H "content-type: application/json" -d '{}'
```
Expected: `401` or `403` (signature missing/invalid) — proves it's reachable AND enforcing signature verification. A `200` here would be a security bug (unsigned acceptance) — the live-call preflight (Task 3.5) refuses to proceed if so.

- [ ] **Step 4: Redeploy Vercel to pick up the URL var**

```bash
npx vercel --prod
```

### Task 3.3: Seed the DNC list (compliance gate)

- [ ] **Step 1: Confirm `dnc_list` is reachable and check current count**

```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); console.log('dnc rows =', (await sql\`SELECT COUNT(*)::int c FROM dnc_list\`)[0].c);"
```

- [ ] **Step 2 (OPERATOR ACTION): Import DNC sources**

**Operator action:** the live-call preflight rejects an empty DNC list. For the 10-call test against *consenting* shippers you control, seed at minimum: (a) any internal opt-out numbers, (b) a known-good test of one DNC number to prove the gate blocks it. Full federal CA (`dncl.gc.ca`) + US (`donotcall.gov`) imports + monthly refresh cron are Phase A.5.2 follow-ups, not blockers for a controlled 10-call test. Document this decision in `consent_log`/`compliance_audit` rationale.

### Task 3.4: Prepare the 10 consenting test shippers

- [ ] **Step 1 (OPERATOR ACTION): Capture consent**

**Operator action:** for each of the 10 test shippers (people who have agreed to receive an AI call), record consent in `consent_log` (CASL/TCPA basis). These must be real, reachable numbers you have permission to call.

- [ ] **Step 2: Build the 10-row import CSV**

Create `MyraTMS/scripts/sprint6-shadow/live-batch-10.csv` with the columns `POST /api/pipeline/import` expects (mirror the synthetic generator's shape — origin, destination, equipment, rate, pickup window, shipper name, shipper phone with prior consent). Keep all 10 high-confidence: equipment in {Dry Van, Reefer, Flatbed}, lanes with active carriers, pickup windows in-hours.

### Task 3.5: Run the live-call preflight gate

- [ ] **Step 1: Execute the aggressive gate**

```bash
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/05-live-call-preflight.ts
echo "EXIT: $?"
```
Expected: `APPROVED`, `EXIT: 0`. This refuses placeholder agent IDs, empty DNC, unsigned-webhook acceptance, calling-hours misconfig, and missing consent. Every `BLOCKED` line is a hard stop — resolve it (Tasks 3.1–3.4), don't override (there's no `--force`).

- [ ] **Step 2: Tick completion.md A.2 + A.5 partials + Change Log**

Mark `A.2.4`, `A.2.5`, `A.2.6` done; note A.5.2 partial. Append a Change Log line. Commit.

---

## Phase 4 — First 10 Live Calls (Phase 6B)

Goal: place ~10 real calls at concurrency 1, listen live, and confirm at least one full booking chain (call → outcome → load created → tracking link). Emergency stop one keystroke away.

### Task 4.1: Flip to live concurrency (the irreversible-ish step)

- [ ] **Step 1: Set MAX_CONCURRENT_CALLS=1 in BOTH Vercel and Railway**

```bash
npx vercel env rm MAX_CONCURRENT_CALLS production; printf '1' | npx vercel env add MAX_CONCURRENT_CALLS production
railway variables --set "MAX_CONCURRENT_CALLS=1"
```

- [ ] **Step 2: Redeploy Vercel + restart Railway so workers pick up the new value**

```bash
npx vercel --prod
railway redeploy   # or: railway up  — forces the worker host to restart with MAX_CONCURRENT_CALLS=1
```

- [ ] **Step 3: Confirm the Voice worker left shadow mode**

```bash
railway logs | grep -i "concurrent\|shadow\|voice"
```
Expected: a log line indicating the Voice worker now permits 1 concurrent call (no longer "shadow mode").

### Task 4.2: Import the 10-shipper batch

- [ ] **Step 1: POST the CSV to the production import endpoint**

```bash
curl -s -X POST https://<prod-domain>/api/pipeline/import \
  -H "Authorization: Bearer $PIPELINE_IMPORT_TOKEN" \
  -F "file=@scripts/sprint6-shadow/live-batch-10.csv"
```
(Set `PIPELINE_IMPORT_TOKEN` in your shell from `.env.local` first.) Expected: JSON `{ imported: 10, ... }`, ≤500-row cap respected.

### Task 4.3: Listen live + watch the pipeline

- [ ] **Step 1: Open the Retell dashboard live-calls view (OPERATOR ACTION)**

**Operator action:** listen to each call in real time. Be ready to hit emergency stop (Task 4.5) if a call goes wrong.

- [ ] **Step 2: Watch calls + outcomes**

```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); console.table(await sql\`SELECT call_id, outcome, persona_name, created_at FROM agent_calls ORDER BY created_at DESC LIMIT 15\`);"
```
Expected: rows appearing with `outcome` transitioning from `in_progress` to a terminal value (booked / lost-to-rate / etc.) as calls complete and the webhook fires.

### Task 4.4: Verify a full booking chain

- [ ] **Step 1: For any `booked` call, confirm the dispatch chain ran**

```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); console.table(await sql\`SELECT pl.id, pl.stage, l.id AS load_id, l.booked_via, l.source FROM pipeline_loads pl JOIN loads l ON l.pipeline_load_id = pl.id WHERE pl.stage IN ('booked','dispatched','delivered') ORDER BY pl.updated_at DESC LIMIT 10\`);"
```
Expected: at least one row where a `loads` record exists with `booked_via='ai_auto'` and `source='Load Board'` (the AI marker per the no-modify-routes rule). Confirms Dispatcher chained `/api/loads → assign → tracking-token → send-tracking` with the service-token JWT.

- [ ] **Step 2: Confirm the prospect-gate held**

```bash
pnpm tsx --env-file=.env.local -e "import {neon} from '@neondatabase/serverless'; const sql=neon(process.env.DATABASE_URL); console.table(await sql\`SELECT stage, COUNT(*)::int FROM pipeline_loads WHERE updated_at > NOW() - INTERVAL '2 hours' GROUP BY stage\`);"
```
Expected: any load whose top carrier was a `prospect` shows `stage='escalated'` (Dispatcher refused to auto-assign), NOT `booked`. This is the safety boundary working.

### Task 4.5: Emergency stop readiness (keep this terminal open the whole time)

- [ ] **Step 1: Know the kill command (do NOT run unless needed)**

```bash
# THREE-LAYER STOP — pauses all 9 queues + disables all loadboard_sources + audit log:
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/07-emergency-stop.ts --reason="<what went wrong>"
```
After an emergency stop: also set `MAX_CONCURRENT_CALLS=0` in Vercel+Railway and redeploy/restart to fully re-enter shadow mode.

### Task 4.6: Phase 4 checkpoint + tracker update

- [ ] **Step 1: Tick completion.md A.4.5 + B.1.x + Change Log**

Mark `A.4.5` done and the relevant `B.1` boxes for the loads that booked. Append:
`- 2026-06-04 — Phase 6B: first N live calls placed at MAX_CONCURRENT_CALLS=1. M booked → loads created with booked_via='ai_auto'. Prospect-gate held (escalated, not dispatched, for prospect carriers). Calls listened-to live.`

```bash
git add "Engine 2/docs/superpowers/plans/completion.md"
git commit -m "Engine 2 A.4.5/B.1: first live calls placed and verified"
```

- [ ] **Step 2: Decide hold vs. ramp**

If calls went well, you're in Phase B of the roadmap (soft launch). If anything was off, return `MAX_CONCURRENT_CALLS=0`, iterate Retell prompts in the dashboard, and re-run a small batch. Do NOT bump concurrency past 1 in this plan — that's Phase C (`C.1`, a separate 2-week ramp).

---

## Phase 5 — Close-out & Minimal Monitoring

Goal: leave the system observable enough to run unattended between test batches.

### Task 5.1: Confirm crons are live in production

- [ ] **Step 1: Verify Vercel registered the 3 pipeline crons**

```bash
npx vercel crons ls
```
Expected: `pipeline-scan`, `pipeline-health`, `feedback-aggregation` listed (schedules from `vercel.json`: 10:00, 11:00, 07:00 daily). Note these are **daily**, not per-minute — for testing you ingest manually via the import endpoint, so a daily API-scan cron is fine.

- [ ] **Step 2: Smoke-test the health cron auth**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<prod-domain>/api/cron/pipeline-health -H "Authorization: Bearer $CRON_SECRET"
```
Expected: `200`. Without the header → `401`.

### Task 5.2: Document the live runbook stub

- [ ] **Step 1: Append operational notes to the shadow README**

Add to `MyraTMS/scripts/sprint6-shadow/README.md` a short "Live operations" section: where logs are (`railway logs`), how to emergency-stop, how to re-enter shadow (`MAX_CONCURRENT_CALLS=0` + redeploy/restart), and the booking-chain verification query from Task 4.4. Commit.

### Task 5.3: Final tracker sync

- [ ] **Step 1: Update completion.md status line + commit**

Bump **Last updated** to `2026-06-04`, set status to reflect "Deployed to prod (Vercel + Railway); 6A GREEN; first live calls placed." Commit.

---

## Self-Review Notes (gaps & assumptions to confirm at execution time)

1. **Railway Root Directory** — the repo is a monorepo; Railway must build from `MyraTMS/`. If `railway up` builds the wrong dir, set Root Directory = `MyraTMS` (Task 1.1 Step 1.3). Verify `pnpm-lock.yaml` is at `MyraTMS/` for `--frozen-lockfile`.
2. **Import CSV column contract** — Task 3.4 assumes the columns `POST /api/pipeline/import` expects match `02-generate-shadow-loads.ts`'s insert shape. At execution, open `app/api/pipeline/import/route.ts` to confirm exact headers before building `live-batch-10.csv`.
3. **`from_number` / phone provisioning** — Retell numbers (A.2.6) may need purchasing in the Retell dashboard; confirm each persona has a valid caller ID before Task 3.5.
4. **DNC scope** — Task 3.3 deliberately scopes DNC to a controlled 10-call test (consenting shippers). Full federal-list import + monthly refresh cron is a roadmap A.5.2 follow-up; flag to the operator that this is a documented, bounded deviation, not full compliance hardening.
5. **Webhook route name** — verified as `/api/webhooks/retell-callback` (not the `retell-webhook.ts` filename in `lib/pipeline/`). Use the route path everywhere Retell config or curl is involved.
6. **Anthropic in shadow vs live** — Researcher Source-5 falls back gracefully if the key is bad (shadow stays green), but the live-call transcript parser (Task 4.3 outcomes) needs a working key. Task 0.2 verifies it up front so a bad key doesn't surface mid-call.
