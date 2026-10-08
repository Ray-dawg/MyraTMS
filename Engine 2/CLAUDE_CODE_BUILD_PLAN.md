# CLAUDE CODE MASTER BUILD PLAN — MYRA LOGISTICS AI AGENT PIPELINE

**Document:** BUILD 11 — The Execution Map
**Created:** April 3, 2026 | **Owner:** Patrice Penda
**Purpose:** This is the ONLY document Claude Code needs. It maps every pre-built module to its codebase destination, orders all work into sequential sprints, and links each task to the specific existing TMS functions, routes, and tables it must call. Follow top to bottom like a recipe.

---

## 1. PROJECT CONTEXT

### What Is Being Built
A 7-agent AI pipeline: find loads on load boards → qualify → research rates → match carriers → compile negotiation briefs → make voice calls via Retell AI → dispatch booked loads through MyraTMS.

### Existing Codebase (MyraTMS)
- **Framework:** Next.js 16 (App Router), React 19, TypeScript 5, pnpm
- **Database:** Neon PostgreSQL (@neondatabase/serverless) — tagged-template SQL, NO ORM
- **Cache:** Upstash Redis (@upstash/redis, REST only currently)
- **Maps:** Mapbox GL (distance + geocoding)
- **AI (current):** xAI Grok-3-mini-fast — Claude API NOT yet integrated
- **Auth:** Custom JWT (jsonwebtoken, bcryptjs)
- **PDF:** PDFKit | **CSV:** PapaParse | **Email:** Nodemailer
- **Deploy:** Vercel with 4 existing cron jobs

### Key Codebase Paths
```
MyraTMS/
├── app/api/                    ← 85 existing API routes
│   ├── loads/                  ← Load CRUD, matching, assignment, tracking
│   ├── carriers/               ← Carrier CRUD, FMCSA compliance
│   ├── quotes/                 ← Quoting engine (6-source rate cascade)
│   ├── loadboard/              ← Load board search + import (DAT/Truckstop)
│   ├── matching/               ← Lane refresh route
│   ├── cron/                   ← 4 existing crons
│   ├── dispatch/               ← Dispatch brief + auto-dispatch
│   ├── compliance/             ← FMCSA verify + batch
│   └── tracking/               ← GPS positions
├── lib/
│   ├── matching/index.ts       ← 5-criteria carrier matching engine
│   ├── quoting/index.ts        ← 6-source rate cascade
│   ├── distance/index.ts       ← Mapbox distance service (30-day cache)
│   ├── database.ts             ← Neon PostgreSQL connection
│   ├── redis.ts                ← Upstash Redis connection
│   └── auth.ts                 ← JWT helpers
├── scripts/                    ← 22 migration files
└── vercel.json                 ← Deploy config + cron entries
```

### Database Query Pattern
```typescript
// Pattern A (most API routes):
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
const result = await sql`SELECT * FROM carriers WHERE id = ${id}`;

// Pattern B (some lib functions):
const result = await db.query('SELECT * FROM carriers WHERE id = $1', [id]);
```
IMPORTANT: Check surrounding code and match the pattern used.

---

## 2. PRE-BUILT MODULE INVENTORY & FILE PLACEMENT

### Foundation Layer
| Source File | → Destination | Purpose |
|---|---|---|
| `pipeline_migrations.sql` | → `scripts/pipeline_migrations.sql` | 13 migrations: 9 new tables + 3 ALTER + 1 seed |
| `stages.ts` | → `lib/pipeline/stages.ts` | Stage enum, validation, transitions |
| `queues.ts` | → `lib/pipeline/queues.ts` | 9 BullMQ queue definitions |
| `payloads.ts` | → `lib/pipeline/payloads.ts` | All job payload TypeScript interfaces |
| `gate.ts` | → `lib/pipeline/gate.ts` | Agent 3+4 parallel completion gate |

### Service Modules
| Source File | → Destination | Purpose |
|---|---|---|
| `claude-service.ts` | → `lib/pipeline/claude-service.ts` | Claude API: retry, parsing, budget, prompts |
| `claude-service-types.ts` | → `lib/pipeline/claude-service-types.ts` | Claude service types |
| `types.ts` | → `lib/pipeline/types.ts` | Shared types (LoadIntelligence, CallParseResult) |
| `examples.ts` | → `lib/pipeline/examples.ts` | Runnable usage examples |
| `compliance-service.ts` | → `lib/pipeline/compliance-service.ts` | CASL/TCPA consent, DNC, calling hours |
| `compliance-types.ts` | → `lib/pipeline/compliance-types.ts` | Compliance types |
| `cost-calculator.ts` | → `lib/pipeline/cost-calculator.ts` | Cost model + negotiation math (pure math) |
| `cost-calculator_test.ts` | → `lib/pipeline/__tests__/cost-calculator.test.ts` | Unit tests |

### Workers (all extend BaseWorker, all have numbered TODOs)
| Source File | → Destination | Agent |
|---|---|---|
| `base-worker.ts` | → `lib/workers/base-worker.ts` | Lifecycle handler |
| `scanner-worker.ts` | → `lib/workers/scanner-worker.ts` | Agent 1 (14 TODOs) |
| `qualifier-worker.ts` | → `lib/workers/qualifier-worker.ts` | Agent 2 (12 TODOs) |
| `researcher-worker.ts` | → `lib/workers/researcher-worker.ts` | Agent 3 (18 TODOs) |
| `ranker-worker.ts` | → `lib/workers/ranker-worker.ts` | Agent 4 (8 TODOs) |
| `compiler-worker.ts` | → `lib/workers/compiler-worker.ts` | Agent 5 (16 TODOs) |
| `voice-worker.ts` | → `lib/workers/voice-worker.ts` | Agent 6 (14 TODOs) |
| `dispatcher-worker.ts` | → `lib/workers/dispatcher-worker.ts` | Agent 7 (8 TODOs) |
| `feedback-worker.ts` | → `lib/workers/feedback-worker.ts` | Feedback (9 TODOs) |
| `index.ts` | → `lib/workers/index.ts` | Exports |

### Webhook & Cron
| Source File | → Destination | Purpose |
|---|---|---|
| `retell-webhook.ts` | → `lib/pipeline/retell-webhook.ts` | Inbound Retell call handler (13 functions) |
| `retell-types.ts` | → `lib/pipeline/retell-types.ts` | 25 Retell interfaces |
| `test-webhook.ts` | → `lib/pipeline/__tests__/retell-webhook.test.ts` | 40+ test cases |
| `cron-handlers.ts` | → `lib/cron/cron-handlers.ts` | 4 pipeline cron jobs |
| `cron-types.ts` | → `lib/cron/cron-types.ts` | Cron types |

### Data Contracts
| Source File | → Destination | Purpose |
|---|---|---|
| `myra_negotiation_brief_schema.ts` | → `lib/pipeline/negotiation-brief.ts` | Brief interface + validation + Retell compiler |

### Retell Config (Reference Only — configure in Retell Dashboard)
| Source File | Purpose |
|---|---|
| `retell_config_v2_gatekeeper.jsx` | Shipper call flow with all dynamic variables |
| `retell_config_carrier_onboarding.jsx` | Carrier onboarding flow |
| `example_retell_payload.json` | Sample webhook payload → `lib/pipeline/fixtures/` |

---

## 3. SETUP SPRINT (30 min)

### 3.1 Install Packages
```bash
pnpm add @anthropic-ai/sdk bullmq ioredis zod
```

### 3.2 Environment Variables (add to Vercel)
```env
ANTHROPIC_API_KEY=sk-ant-...
RETELL_API_KEY=...
RETELL_WEBHOOK_SECRET=...
RETELL_OUTBOUND_NUMBER_1=+1XXXXXXXXXX
RETELL_OUTBOUND_NUMBER_2=+1XXXXXXXXXX
PIPELINE_ENABLED=false
SCANNER_ENABLED=false
AUTO_BOOK_PROFIT_THRESHOLD=999999
MAX_CONCURRENT_CALLS=5
ALERT_EMAIL=patrice.penda@myraai.ca
```

### 3.3 Create BullMQ Redis Connection
BullMQ needs IORedis, NOT Upstash REST. Create `lib/pipeline/redis-bullmq.ts`:
```typescript
import IORedis from 'ioredis';
const REDIS_URL = process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('Redis URL required for BullMQ');
export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, enableReadyCheck: false,
  tls: { rejectUnauthorized: false },
});
```
NOTE: Get ioredis-compatible URL from Upstash dashboard → Connect → ioredis tab.

### 3.4 Copy All Pre-Built Files
Copy every file from Section 2 to its destination. Then:
```bash
pnpm tsc --noEmit
```
Fix import paths. Common issues: database import path, logger import, Redis import.

### 3.5 Create Logger If Missing
```typescript
// lib/logger.ts
export const logger = {
  info: (msg: string, data?: any) => console.log(JSON.stringify({ level: 'info', message: msg, ...data, ts: new Date().toISOString() })),
  warn: (msg: string, data?: any) => console.warn(JSON.stringify({ level: 'warn', message: msg, ...data, ts: new Date().toISOString() })),
  error: (msg: string, data?: any) => console.error(JSON.stringify({ level: 'error', message: msg, ...data, ts: new Date().toISOString() })),
  debug: (msg: string, data?: any) => console.log(JSON.stringify({ level: 'debug', message: msg, ...data, ts: new Date().toISOString() })),
};
```

### 3.6 Verify: `pnpm tsc --noEmit` → zero errors

---

## 4. SPRINT 1 — DATABASE & QUEUE FOUNDATION (1-2 hrs)

### 4.1 Run Migrations
```bash
psql $DATABASE_URL -f scripts/pipeline_migrations.sql
```

### 4.2 Verify (run each query, confirm expected row counts)
```sql
-- 9 new tables
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
AND table_name IN ('pipeline_loads','agent_calls','negotiation_briefs','consent_log','dnc_list','shipper_preferences','lane_stats','personas','agent_jobs');

-- 3 personas seeded
SELECT persona_name, is_active FROM personas;

-- Column additions
SELECT column_name FROM information_schema.columns WHERE table_name = 'loads' AND column_name IN ('pipeline_load_id','source_type','booked_via');
SELECT column_name FROM information_schema.columns WHERE table_name = 'carriers' AND column_name IN ('accepts_ai_dispatch','ai_call_count');
SELECT column_name FROM information_schema.columns WHERE table_name = 'shippers' AND column_name IN ('consent_status','preferred_language','shipper_fatigue_score');
```

### 4.3 Test Queue Connection
```bash
npx tsx scripts/test-queue-connection.ts
# Should print "Queue connection: OK"
```

**✅ CHECKPOINT: Tables exist, personas seeded, BullMQ connects.**

---

## 5. SPRINT 2 — AGENTS 2 + 4 (3-5 hrs)
**Pure SQL + existing matching engine. No external APIs. Fastest wins.**

### AGENT 2 — qualifier-worker.ts (12 TODOs)

**TODO Q-1: Equipment Normalization**
First discover TMS values: `SELECT DISTINCT equipment_type FROM carrier_equipment;`
Create mapping: 'Van'→'dry_van', 'Flatbed'→'flatbed', 'Reefer'→'reefer', 'Tanker'→'tanker', etc.

**TODO Q-2: Region Mapper**
Import from quoting engine: `import { resolveRegion } from '@/lib/quoting';`
If not importable, replicate: 20 Ontario cities → region strings, fallback to province code.

**TODO Q-3: Lane Coverage Query**
```sql
SELECT COUNT(DISTINCT cl.carrier_id) as count
FROM carrier_lanes cl JOIN carriers c ON cl.carrier_id = c.id
WHERE (cl.origin_region = $1 OR cl.origin_region = 'Ontario')
  AND (cl.dest_region = $2 OR cl.dest_region = 'Ontario')
  AND c.status = 'Active'
```

**TODO Q-4: Benchmark Rate**
`import { calculateTotalCost } from '@/lib/pipeline/cost-calculator';`

**TODO Q-5: DNC Check**
```typescript
import { ComplianceService } from '@/lib/pipeline/compliance-service';
const compliance = new ComplianceService(db);
const dnc = await compliance.checkDNC(phone);
```

**TODO Q-6: Fatigue Check**
`SELECT shipper_fatigue_score FROM shippers WHERE phone = $1;` — fail if >= 3.

**TODO Q-7: Priority Scoring** — mostly written, wire in benchmark rate import.

**TODO Q-8: Parallel Enqueue**
```typescript
const researchQueue = new Queue('research-queue', { connection: redisConnection });
const matchQueue = new Queue('match-queue', { connection: redisConnection });
await researchQueue.add('research', { pipelineLoadId, qualifiedLoad }, { priority });
await matchQueue.add('match', { pipelineLoadId, qualifiedLoad }, { priority });
```

**VERIFY:** Insert fake pipeline_load (stage='scanned'), process, confirm it moves to qualified/disqualified.

---

### AGENT 4 — ranker-worker.ts (8 TODOs)

**TODO R-1: Call Matching Engine**
FIRST discover exports: `grep -r "export" lib/matching/`
```typescript
import { runMatchingEngine } from '@/lib/matching';
```
If it expects a load ID (reads from loads table) rather than object, call the API route instead:
`POST /api/loads/${tempId}/match`

**TODO R-2: Filter F-Grade**
```typescript
const viable = matchResults.filter(m => m.match_grade !== 'F').sort((a,b) => b.match_score - a.match_score).slice(0,3);
```

**TODO R-3: Build CarrierStackEntry** — query `carriers` table for each match.

**TODO R-4: Availability Confidence**
- High: GPS ping < 24h near origin + equipment confirmed
- Medium: Home base in region or lane < 30 days
- Low: Equipment only
Query: `SELECT * FROM location_pings WHERE carrier_id=$1 AND pinged_at > NOW()-INTERVAL '24h' LIMIT 1`

**TODO R-5: Store match_results**
```sql
INSERT INTO match_results (load_id, carrier_id, match_score, match_grade, breakdown, created_at) VALUES ($1,$2,$3,$4,$5,NOW());
```

**TODO R-6: Completion Gate** — check `research_completed_at IS NOT NULL`, advance to 'matched', enqueue brief-queue.

**VERIFY:** Insert pipeline_load (stage='qualified'), process, confirm carrier_match_count > 0.

**✅ CHECKPOINT: Agents 2+4 compile, process loads, advance stages.**

---

## 6. SPRINT 3 — AGENTS 3 + 5 (5-8 hrs)

### AGENT 3 — researcher-worker.ts (18 TODOs)

**TODO RE-1: Distance**
```typescript
import { getDistance } from '@/lib/distance';
const dist = await getDistance({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
```

**TODO RE-2: Rate Cascade**
```typescript
import { generateQuote } from '@/lib/quoting'; // verify exact export name
```
For AI source (#5), replace Grok with Claude:
```typescript
import { ClaudeService } from '@/lib/pipeline/claude-service';
const claude = new ClaudeService({ model: 'claude-sonnet-4-20250514' });
const research = await claude.research(loadParams, jobId);
```

**TODO RE-3: Cost Calculation**
```typescript
import { calculateTotalCost } from '@/lib/pipeline/cost-calculator';
```

**TODO RE-4: Negotiation Envelope**
```typescript
import { calculateNegotiationParams } from '@/lib/pipeline/cost-calculator';
```

**TODO RE-5: Shipper Profile**
```sql
SELECT * FROM shipper_preferences WHERE phone = $1;
SELECT outcome, COUNT(*) FROM agent_calls WHERE phone_number_called = $1 GROUP BY outcome;
```

**TODO RE-6: Strategy**
```typescript
if (margin > 500 && carriers >= 2) return 'aggressive';
if (margin < 200 || carriers === 0) return 'walk';
return 'standard';
```

**TODO RE-7: Completion Gate** — same pattern as Agent 4.

---

### AGENT 5 — compiler-worker.ts (16 TODOs)

**TODO C-1: Thompson Sampling**
```typescript
function selectPersona(personas: {persona_name:string; alpha:number; beta:number}[]): string {
  let best = -1, pick = 'friendly';
  for (const p of personas) {
    const u1 = Math.pow(Math.random(), 1/p.alpha);
    const u2 = Math.pow(Math.random(), 1/p.beta);
    const s = u1/(u1+u2);
    if (s > best) { best = s; pick = p.persona_name; }
  }
  return pick;
}
```
Query: `SELECT persona_name, alpha, beta, retell_agent_id_en FROM personas WHERE is_active = true;`

**TODO C-2: Objection Playbook** — static constant with 9 types: rate_too_high, have_broker, dont_use_brokers, not_decision_maker, call_back, send_email, handle_internally, better_offer, customer_routed. Full scripts are in C-04 Voice Agent Conversation Playbook and retell_config_v2_gatekeeper.jsx.

**TODO C-3: Compliance**
```typescript
import { ComplianceService } from '@/lib/pipeline/compliance-service';
```

**TODO C-4: Validation**
```typescript
import { validateBrief } from '@/lib/pipeline/negotiation-brief';
```

**TODO C-5: Store Brief**
```sql
INSERT INTO negotiation_briefs (pipeline_load_id, brief, brief_version, persona_selected, strategy, initial_offer, target_rate, min_acceptable_rate, concession_step_1, concession_step_2, final_offer, carrier_count, top_carrier_id, top_carrier_rate, created_at) VALUES (...) RETURNING id;
```

**TODO C-6: Enqueue call-queue**
```typescript
await callQueue.add('call', { pipelineLoadId, briefId, shipperPhone, persona, retellAgentId, language }, { priority: estimatedProfit });
```

**✅ CHECKPOINT: Pipeline processes loads from scanned → qualified → matched → briefed.**

---

## 7. SPRINT 4 — AGENTS 1 + 6 + WEBHOOK (4-6 hrs)

### AGENT 1 — scanner-worker.ts (14 TODOs)
START WITH CSV FALLBACK. Create `app/api/pipeline/import/route.ts` — accepts CSV, parses with PapaParse, maps to pipeline_loads, enqueues qualify-queue. Reuse pattern from existing `app/api/import/execute/route.ts`.

### AGENT 6 — voice-worker.ts (14 TODOs)
**Retell API Call:**
```typescript
await fetch('https://api.retellai.com/v2/create-phone-call', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agent_id: brief.persona.retellAgentId,
    customer_number: brief.shipper.phone,
    from_number: getOutboundNumber(),
    metadata: { pipelineLoadId: String(id), briefId: String(briefId), persona: brief.persona.personaName },
    retell_llm_dynamic_variables: {
      shipper_name: brief.shipper.contactName, shipper_company: brief.shipper.companyName,
      origin_city: brief.load.originCity, destination_city: brief.load.destinationCity,
      initial_rate: String(brief.negotiation.initialOffer),
      concession_step_1: String(brief.negotiation.concessionStep1),
      concession_step_2: String(brief.negotiation.concessionStep2),
      final_offer: String(brief.negotiation.finalOffer),
      currency: brief.rates.currency,
      // ... full variable map in retell_config_v2_gatekeeper.jsx
    },
  }),
});
```

### WEBHOOK — Create `app/api/webhooks/retell-callback/route.ts`
```typescript
import { handleRetellWebhook } from '@/lib/pipeline/retell-webhook';
export const runtime = 'nodejs';
export const maxDuration = 30;
export async function POST(req: Request) {
  const result = await handleRetellWebhook(req);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
}
```

**✅ CHECKPOINT: Full pipeline from CSV import → voice call → webhook → stage update.**

---

## 8. SPRINT 5 — AGENT 7 + FEEDBACK + CRONS (3-4 hrs)

### AGENT 7 — dispatcher-worker.ts (8 TODOs)
Service token: `jwt.sign({ userId:'system', role:'admin', type:'service' }, JWT_SECRET, { expiresIn:'1h' })`

Then call existing TMS routes IN ORDER:
1. `POST /api/loads` — create load (source_type='ai_agent', booked_via='ai_auto')
2. `POST /api/loads/[id]/assign` — assign carrier + generate rate con PDF
3. `POST /api/loads/[id]/tracking-token` — generate tracking
4. `POST /api/loads/[id]/send-tracking` — email shipper

### CRONS — Add to vercel.json:
```json
{ "crons": [
  { "path": "/api/cron/pipeline-scan", "schedule": "* * * * *" },
  { "path": "/api/cron/pipeline-health", "schedule": "*/5 * * * *" },
  { "path": "/api/cron/feedback-aggregation", "schedule": "0 7 * * *" }
]}
```
Create route handlers that call pre-built `cron-handlers.ts`. Always check `PIPELINE_ENABLED` and `CRON_SECRET`.

**✅ CHECKPOINT: Full pipeline operational. Crons running. Kill switches configured.**

---

## 9. TESTING & SHADOW MODE

### Shadow Mode: Set MAX_CONCURRENT_CALLS=0, run Agents 1-5 without calls.
Check: qualification rates (20-30%), rate accuracy, carrier matching (1-3 per brief), brief quality.

### First 10 Live Calls:
1. PIPELINE_ENABLED=true, MAX_CONCURRENT_CALLS=1
2. Import 10 loads with REAL shipper phones
3. Patrice listens via Retell dashboard
4. Check agent_calls for parsed results
5. Verify profit calculations
6. Adjust Claude prompts if needed

---

## APPENDIX A — EXISTING TMS FUNCTIONS (DO NOT REWRITE)

| Function | Location | Used By |
|---|---|---|
| `runMatchingEngine()` | `lib/matching/index.ts` | Agent 4 |
| `getDistance()` | `lib/distance/index.ts` | Agent 3 |
| `generateQuote()` | `lib/quoting/index.ts` | Agent 3 |
| `rateCascade()` | `lib/quoting/index.ts` | Agent 3 |
| `resolveRegion()` | `lib/quoting/` | Agent 2 |

**CRITICAL: Verify exact export names:**
```bash
grep -r "export.*function\|export.*const" lib/matching/ lib/quoting/ lib/distance/
```

## APPENDIX B — EXISTING DATABASE TABLES

| Table | Key Columns | Used By |
|---|---|---|
| carriers | id, company_name, contact_name, contact_phone, status, authority_status, insurance_status, home_base_city, on_time_rate, communication_rating, total_loads | Agents 2, 4 |
| carrier_equipment | carrier_id, equipment_type, truck_count | Agent 2 |
| carrier_lanes | carrier_id, origin_region, dest_region, equipment_type, load_count, avg_carrier_rate | Agents 2, 4 |
| loads | Full CRUD — Agent 7 creates rows | Agent 7 |
| match_results | load_id, carrier_id, match_score, match_grade, breakdown | Agent 4 |
| quotes | Rate history + confidence | Agent 3 |
| distance_cache | Mapbox results (30-day TTL) | Agent 3 |
| rates | Manual rate cache | Agent 3 |
| location_pings | Driver GPS | Agent 4 |
| shippers | shipper_fatigue_score, preferred_language | Agents 2, 5 |

## APPENDIX C — EXISTING API ROUTES (Agent 7 calls these)

| Route | Method | Purpose |
|---|---|---|
| /api/loads | POST | Create load |
| /api/loads/[id] | PATCH | Update load |
| /api/loads/[id]/assign | POST | Assign carrier + rate con PDF |
| /api/loads/[id]/tracking-token | POST | Generate tracking |
| /api/loads/[id]/send-tracking | POST | Email tracking link |
| /api/loads/[id]/match | POST | Run matching engine |
| /api/matching/refresh-lanes | POST | Rebuild carrier_lanes |
| /api/quotes | POST | Generate quote (rate cascade) |
| /api/compliance/verify | POST | FMCSA verification |

## APPENDIX D — TODO COUNTS BY SPRINT

| Sprint | Agents | TODOs | Hours |
|---|---|---|---|
| Sprint 2 | Agent 2 (12) + Agent 4 (8) | 20 | 3-5 |
| Sprint 3 | Agent 3 (18) + Agent 5 (16) | 34 | 5-8 |
| Sprint 4 | Agent 1 (14) + Agent 6 (14) | 28 | 4-6 |
| Sprint 5 | Agent 7 (8) + Feedback (9) | 17 | 3-4 |
| **TOTAL** | **8 workers** | **99** | **~20-35 hrs** |

---

## EXECUTION SUMMARY

```
SETUP       →  Packages, env vars, file placement           (30 min)
SPRINT 1    →  Database migrations, queue test                (1-2 hrs)
SPRINT 2    →  Agents 2 + 4 (SQL + matching engine)          (3-5 hrs)
SPRINT 3    →  Agents 3 + 5 (Claude API + brief compile)     (5-8 hrs)
SPRINT 4    →  Agents 1 + 6 + webhook (external APIs)        (4-6 hrs)
SPRINT 5    →  Agent 7 + feedback + crons                     (3-4 hrs)
TESTING     →  Shadow mode + first 10 live calls              (4-8 hrs)
───────────────────────────────────────────────────────────────────
TOTAL       →  ~20-35 hours = 3-5 full days of Claude Code
```

This document is the single source of truth. Do not read T-series specs unless resolving an ambiguity.

---
BUILD 11 COMPLETE — April 3, 2026 | Patrice Penda, Myra Logistics
