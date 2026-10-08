---
title: Agent 1 Fallback — Headless Browser Load Board Scanner
id: T-04A
version: 1.0
date: 2026-04-30
owner: Patrice Penda
status: current
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-01, T-02, T-03, T-04]
referenced_by: [scanner-worker.ts, pipeline_loads, qualify-queue]
shelf_life: ~60 days — kill once DAT/Truckstop/123LB/Loadlink official API keys are provisioned
---

# T-04A: HEADLESS BROWSER LOAD BOARD SCANNER (FALLBACK FOR AGENT 1)

**Myra Logistics — Technical Specification**
**Build target:** Claude Code Pro Max — single 4.5-hour session
**Output:** `/scraper` directory, deployable as standalone worker process
**Primary deliverable:** Working DAT scraper writing real loads into `pipeline_loads` and enqueueing to `qualify-queue`. Stubs only for Truckstop, 123Loadboard, Loadlink.

---

## 0. Why this exists

Engine 2 (the AI agent pipeline — Scanner → Qualifier → Researcher → Ranker → Compiler → Voice → Dispatcher) is built. The pipeline accepts loads via `pipeline_loads` and processes them via BullMQ workers. The blocker is **input volume**: API access from DAT, 123Loadboard, Truckstop, TruckPath, and Loadlink is in onboarding queues. Until those keys are provisioned, the pipeline runs dry.

This spec defines a **headless browser scraper** that uses Patrice's existing paid broker logins to ingest loads via the same UI a human operator would use. Its sole purpose is to keep the pipeline fed during the API-onboarding gap. Once any official API is provisioned, the corresponding adapter is retired and the API integration in `scanner-worker.ts` (T-04) takes over.

This is a **bridge layer**, not a permanent component.

---

## 1. Risk, Compliance, and Operational Boundaries

### 1.1 Legal posture

Operating this scraper carries the following risk factors. Patrice has reviewed and accepted these prior to build:

| Risk | Severity | Mitigation |
|---|---|---|
| Violation of load board Terms of Service | High | Single-seat use, low volume (≥5-min poll interval), no data redistribution, no resale of scraped data |
| Account suspension on detection | High | Stealth plugin, residential proxy support, randomized delays, session persistence to avoid login flooding |
| IP ban | Medium | Egress through residential proxy on a per-board basis (configurable) |
| Civil claim from load board operator | Low (with safeguards) | Use only data Patrice's seat is authorized to access; never expose scraped data to third parties; do not bypass paywalls |
| Data quality issues breaking pipeline | Medium | Strict schema validation before write to `pipeline_loads`; log-and-skip on parse failures |

### 1.2 Operational boundaries

The scraper:
- **Must** use Patrice's own paid broker credentials (one seat per board)
- **Must** rate-limit at minimum 5 minutes between polls per board (target: 5–15 min with jitter)
- **Must** respect a hard kill switch (`SCRAPER_ENABLED=false` env var) checked at the start of every poll
- **Must not** bypass MFA programmatically — when MFA is required, surface a Slack alert and pause polling for that board
- **Must not** scrape pages or endpoints not part of normal broker workflow
- **Must not** be exposed to additional users; this is single-tenant infrastructure for `tenant_id=1` (Myra primary)

### 1.3 Shelf-life trigger

The scraper retires (per board) the moment that board's official API key is provisioned and validated. Build a calendar reminder for **May 30, 2026** to audit which boards are still on scrape mode.

---

## 2. Architecture

### 2.1 High-level

```
┌────────────────────┐
│  Scheduler (node)  │  setInterval(POLL_MS) per board, with jitter
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ LoadBoardAdapter   │  3-function interface: authenticate / search / parseResult
│  ├── DATAdapter    │
│  ├── TruckstopAdapter (stub)
│  ├── LoadboardAdapter123 (stub)
│  └── LoadlinkAdapter (stub)
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Browser Pool       │  playwright-extra + stealth plugin
│  Persistent context per board
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Session Store      │  Redis: cookies + storage state per board
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Normalize → RawLoad│  Reuses interface from T-04
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐         ┌──────────────────┐
│ Dedup + DB write   │────────►│ pipeline_loads   │
└─────────┬──────────┘         └──────────────────┘
          │
          ▼
┌────────────────────┐         ┌──────────────────┐
│ Enqueue qualify-q  │────────►│ qualify-queue    │
└─────────┬──────────┘         └──────────────────┘
          │
          ▼
┌────────────────────┐
│ Observability      │  scraper_runs / scraper_log / Slack on error
└────────────────────┘
```

### 2.2 Stack

| Component | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 20 LTS | Matches main app; Playwright supported |
| Browser automation | Playwright (TypeScript) | More reliable than Puppeteer for evasion + Chromium-bundled |
| Anti-detection | `playwright-extra` + `puppeteer-extra-plugin-stealth` | Defeats most basic bot fingerprinting |
| Session store | Redis (Upstash, shared with main app) | Cookies + storage state survive container restarts |
| Queue client | `bullmq` (same version as main app) | Direct enqueue to existing `qualify-queue` |
| DB client | `pg` (same connection string as main app) | Direct write to `pipeline_loads` |
| Logger | `pino` | Structured JSON, low overhead |
| Scheduling | Native `setInterval` with jitter | No need for cron daemon for 1–6 polls/hour |
| Deployment | Railway (recommended) | Long-running worker, $5–10/mo, Dockerfile-friendly. Render and Fly.io are acceptable alternatives. **Vercel will not work** — serverless functions cannot host persistent browser contexts. |
| Observability | Slack webhook + `scraper_runs` table | Lightweight; no need for Datadog/Grafana yet |

### 2.3 Process model

**One process, multiple boards.** Each board runs on its own polling interval inside a single Node.js process. Browser contexts are pooled (one persistent context per board, reused across polls). On a single Railway worker (~512 MB RAM), DAT + 1 stub board is comfortable. Scaling beyond that → split into one process per board.

---

## 3. Repository Structure

```
/scraper
├── README.md
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── src/
│   ├── index.ts                    # Entry point: starts scheduler
│   ├── config.ts                   # Env var loading + validation (zod)
│   ├── scheduler.ts                # Per-board interval orchestration
│   ├── browser/
│   │   ├── pool.ts                 # Browser context pool
│   │   ├── stealth.ts              # playwright-extra setup
│   │   └── session-store.ts        # Redis cookie persistence
│   ├── adapters/
│   │   ├── base.ts                 # LoadBoardAdapter interface
│   │   ├── dat/
│   │   │   ├── index.ts            # DATAdapter (authenticate, search, parseResult)
│   │   │   ├── selectors.ts        # All DOM selectors, env-overridable
│   │   │   ├── login.ts            # Login flow + MFA detection
│   │   │   └── parse.ts            # HTML/DOM → RawLoad mapping
│   │   ├── truckstop/
│   │   │   └── index.ts            # Stub
│   │   ├── loadboard123/
│   │   │   └── index.ts            # Stub
│   │   └── loadlink/
│   │       └── index.ts            # Stub
│   ├── pipeline/
│   │   ├── normalize.ts            # Source → RawLoad
│   │   ├── dedup.ts                # Cross-source dedup
│   │   ├── db.ts                   # Pipeline_loads writer
│   │   └── enqueue.ts              # qualify-queue writer
│   ├── observability/
│   │   ├── logger.ts               # pino instance
│   │   ├── slack.ts                # Webhook helper
│   │   └── metrics.ts              # scraper_runs / scraper_log writers
│   └── lib/
│       ├── jitter.ts               # Random delay helpers
│       ├── retry.ts                # Backoff helpers
│       └── shutdown.ts             # SIGTERM handling
├── migrations/
│   └── 001_scraper_tables.sql      # scraper_runs + scraper_log
└── test/
    ├── fixtures/
    │   ├── dat-results.html        # Saved DOM snapshot for parser tests
    │   └── dat-login.html
    └── parse.test.ts
```

---

## 4. Environment Configuration

### 4.1 `.env.example`

```bash
# ─────────────────────────────────────────────────────────────────
# CORE
# ─────────────────────────────────────────────────────────────────
NODE_ENV=production
LOG_LEVEL=info

# Master kill switch — set false to halt all scraping immediately
SCRAPER_ENABLED=true

# Tenant context (Myra primary = 1)
TENANT_ID=1

# ─────────────────────────────────────────────────────────────────
# SHARED INFRASTRUCTURE (same as main app)
# ─────────────────────────────────────────────────────────────────
DATABASE_URL=postgres://...                # Neon PostgreSQL
REDIS_URL=rediss://...                     # Upstash Redis
QUALIFY_QUEUE_NAME=qualify-queue

# ─────────────────────────────────────────────────────────────────
# DAT
# ─────────────────────────────────────────────────────────────────
DAT_ENABLED=true
DAT_USERNAME=patrice@myraai.ca
DAT_PASSWORD=                              # set in Railway secrets, never commit
DAT_LOGIN_URL=https://power.dat.com/login
DAT_SEARCH_URL=https://power.dat.com/search
DAT_AUTH_PROBE_URL=https://power.dat.com/account/profile  # used to detect session expiry
DAT_POLL_INTERVAL_MS=300000                # 5 min default
DAT_POLL_JITTER_MS=60000                   # ±60s randomization
DAT_PROXY_URL=                             # optional residential proxy: http://user:pass@host:port

# DAT search defaults — initial scan window
DAT_EQUIPMENT=DRY_VAN,FLATBED,REEFER       # comma-separated normalized values
DAT_ORIGIN_PROVINCES=ON,AB                 # comma-separated province codes
DAT_DAYS_FORWARD=7                         # pickup within next N days

# DAT selectors — optional overrides for when DAT changes UI
# DAT_SEL_USERNAME=#username
# DAT_SEL_PASSWORD=#password
# DAT_SEL_LOGIN_BUTTON=button[type="submit"]
# DAT_SEL_RESULTS_TABLE=table[data-test="results-table"]
# DAT_SEL_RESULT_ROW=tr[data-test="result-row"]

# ─────────────────────────────────────────────────────────────────
# OTHER BOARDS (stubbed for v1)
# ─────────────────────────────────────────────────────────────────
TRUCKSTOP_ENABLED=false
TRUCKSTOP_USERNAME=
TRUCKSTOP_PASSWORD=
TRUCKSTOP_LOGIN_URL=https://truckstop.com/login

LOADBOARD123_ENABLED=false
LOADBOARD123_USERNAME=
LOADBOARD123_PASSWORD=
LOADBOARD123_LOGIN_URL=https://www.123loadboard.com/login

LOADLINK_ENABLED=false
LOADLINK_USERNAME=
LOADLINK_PASSWORD=
LOADLINK_LOGIN_URL=https://www.loadlink.ca/login

# ─────────────────────────────────────────────────────────────────
# OBSERVABILITY
# ─────────────────────────────────────────────────────────────────
SLACK_WEBHOOK_URL=                         # Slack incoming webhook for alerts
SLACK_ALERT_CHANNEL=#myra-scraper

# ─────────────────────────────────────────────────────────────────
# BROWSER
# ─────────────────────────────────────────────────────────────────
HEADLESS=true                              # set false locally to debug
USER_AGENT_ROTATION=true                   # rotate from a small whitelist
SCREENSHOT_ON_ERROR=true                   # debug aid — written to /tmp
```

### 4.2 Validation

All env vars validated at boot via `zod`. Missing/invalid values → fail fast with a clear error, not a runtime crash 30 minutes in.

```typescript
// src/config.ts
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  SCRAPER_ENABLED: z.coerce.boolean().default(true),
  TENANT_ID: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  QUALIFY_QUEUE_NAME: z.string().default('qualify-queue'),

  DAT_ENABLED: z.coerce.boolean().default(false),
  DAT_USERNAME: z.string().optional(),
  DAT_PASSWORD: z.string().optional(),
  DAT_LOGIN_URL: z.string().url().optional(),
  DAT_POLL_INTERVAL_MS: z.coerce.number().int().min(180000).default(300000), // min 3 min
  DAT_POLL_JITTER_MS: z.coerce.number().int().default(60000),
  DAT_EQUIPMENT: z.string().default('DRY_VAN,FLATBED,REEFER'),
  DAT_ORIGIN_PROVINCES: z.string().default('ON,AB'),
  DAT_DAYS_FORWARD: z.coerce.number().int().min(1).max(14).default(7),
  DAT_PROXY_URL: z.string().optional(),

  // ... etc

  HEADLESS: z.coerce.boolean().default(true),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.DAT_ENABLED && (!cfg.DAT_USERNAME || !cfg.DAT_PASSWORD)) {
    ctx.addIssue({ code: 'custom', message: 'DAT_ENABLED requires DAT_USERNAME and DAT_PASSWORD' });
  }
});

export const config = ConfigSchema.parse(process.env);
```

---

## 5. Database Migration

The scraper introduces two new observability tables. These are **additive only** — they do not modify any existing T-02 schema.

### 5.1 `migrations/001_scraper_tables.sql`

```sql
-- ============================================================================
-- T-04A: HEADLESS SCANNER OBSERVABILITY TABLES
-- ============================================================================
-- Source: T-04A Headless Scanner Fallback Specification
-- Target: Neon PostgreSQL (serverless)
-- Idempotent: yes (IF NOT EXISTS)
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- scraper_runs — one row per polling cycle, per source
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scraper_runs (
    id                  SERIAL PRIMARY KEY,
    source              VARCHAR(50)  NOT NULL,    -- 'dat' | 'truckstop' | '123lb' | 'loadlink'
    tenant_id           INTEGER      NOT NULL DEFAULT 1,

    started_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at        TIMESTAMP,

    status              VARCHAR(20)  NOT NULL DEFAULT 'running',
                        -- 'running' | 'success' | 'partial' | 'failed' | 'auth_required'

    loads_found         INTEGER      DEFAULT 0,
    loads_inserted      INTEGER      DEFAULT 0,
    loads_duplicates    INTEGER      DEFAULT 0,
    loads_skipped       INTEGER      DEFAULT 0,   -- parse failures, validation errors

    error_message       TEXT,
    error_stack         TEXT,

    duration_ms         INTEGER,

    -- Operational metadata
    user_agent          VARCHAR(500),
    proxy_used          VARCHAR(200),
    session_reused      BOOLEAN      DEFAULT false,

    created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scraper_runs_source_started
    ON scraper_runs(source, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scraper_runs_status
    ON scraper_runs(status, started_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- scraper_log — granular events within a run
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scraper_log (
    id                  SERIAL PRIMARY KEY,
    run_id              INTEGER REFERENCES scraper_runs(id) ON DELETE CASCADE,

    level               VARCHAR(10)  NOT NULL,    -- 'debug' | 'info' | 'warn' | 'error'
    event               VARCHAR(50)  NOT NULL,    -- 'login_attempted' | 'load_parsed' | etc.
    message             TEXT,
    metadata            JSONB,

    created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scraper_log_run
    ON scraper_log(run_id);

CREATE INDEX IF NOT EXISTS idx_scraper_log_event
    ON scraper_log(event, created_at DESC);

COMMIT;
```

### 5.2 Migration to existing `pipeline_loads` (no schema changes)

`pipeline_loads` already accepts `load_board_source` as `VARCHAR(50)`. The scraper writes the same source codes as the official API path: `'dat'`, `'truckstop'`, `'123lb'`, `'loadlink'`. **No T-02 modifications.**

To distinguish scrape-sourced loads from API-sourced loads (useful for debugging, not enforcement), the scraper writes `created_by = 'scraper-v1'` instead of `'scanner-v1'`. This already-existing column is sufficient.

---

## 6. The Adapter Interface

Every load board implements three async functions. Anything else is shared infrastructure.

### 6.1 `src/adapters/base.ts`

```typescript
import type { BrowserContext, Page } from 'playwright';
import type { RawLoad } from '../pipeline/normalize';

/**
 * Search query passed into adapter.search()
 * Adapters translate this into board-specific UI interactions.
 */
export interface SearchQuery {
  equipmentTypes: Array<'dry_van' | 'flatbed' | 'reefer' | 'tanker' | 'step_deck'>;
  originProvinces: string[];      // e.g. ['ON', 'AB']
  pickupDateFrom: Date;
  pickupDateTo: Date;
  originRadiusMiles?: number;     // optional, default 250
  destinationRadiusMiles?: number;
}

/**
 * Result of an authenticate() call.
 */
export interface AuthResult {
  success: boolean;
  reason?: 'invalid_credentials' | 'mfa_required' | 'captcha' | 'rate_limited' | 'unknown';
  detail?: string;
  sessionReused?: boolean;        // true if existing Redis session was valid
}

/**
 * Result of a parseResult() call — raw, pre-normalization.
 */
export interface ParsedRow {
  // Adapter-specific fields. Each adapter parses what its UI exposes.
  // The pipeline/normalize.ts layer maps this to RawLoad.
  [key: string]: any;
  __source: string;               // 'dat' | 'truckstop' | etc.
  __scrapedAt: string;            // ISO timestamp
}

/**
 * The contract every load board adapter must implement.
 * Adding a new board = implementing this interface only.
 */
export interface LoadBoardAdapter {
  readonly source: 'dat' | 'truckstop' | '123lb' | 'loadlink';

  /**
   * Establish an authenticated session.
   * Should attempt session reuse from Redis first; falls back to login.
   * Returns success=false with a reason on auth failures — does not throw.
   */
  authenticate(context: BrowserContext): Promise<AuthResult>;

  /**
   * Execute a search using the authenticated session.
   * Returns the page positioned at the search results.
   */
  search(page: Page, query: SearchQuery): Promise<Page>;

  /**
   * Parse the current page's results into structured rows.
   * Should NOT normalize to RawLoad — that's the pipeline layer's job.
   * Returns one entry per row visible on the page (pagination handled internally if needed).
   */
  parseResult(page: Page): Promise<ParsedRow[]>;
}
```

### 6.2 Adapter base class (optional shared helpers)

```typescript
// src/adapters/base.ts (continued)

export abstract class BaseAdapter implements LoadBoardAdapter {
  abstract readonly source: LoadBoardAdapter['source'];
  abstract authenticate(context: BrowserContext): Promise<AuthResult>;
  abstract search(page: Page, query: SearchQuery): Promise<Page>;
  abstract parseResult(page: Page): Promise<ParsedRow[]>;

  protected async humanDelay(min = 800, max = 2400): Promise<void> {
    const ms = min + Math.random() * (max - min);
    await new Promise(r => setTimeout(r, ms));
  }

  protected async humanType(page: Page, selector: string, text: string): Promise<void> {
    await page.click(selector);
    for (const char of text) {
      await page.keyboard.type(char);
      await new Promise(r => setTimeout(r, 60 + Math.random() * 90));
    }
  }
}
```

---

## 7. Browser & Session Infrastructure

### 7.1 `src/browser/stealth.ts`

```typescript
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Apply stealth plugin (defeats common bot detection: navigator.webdriver, headless flags, etc.)
chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

export function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export { chromium };
```

### 7.2 `src/browser/session-store.ts`

Sessions persist as Playwright `storageState` JSON in Redis. Key format: `scraper:session:{source}`. TTL: 24 hours (DAT sessions typically last longer, but we cap defensively).

```typescript
import type { BrowserContext } from 'playwright';
import IORedis from 'ioredis';

const SESSION_TTL_SECONDS = 24 * 3600;

export class SessionStore {
  constructor(private redis: IORedis) {}

  private key(source: string): string {
    return `scraper:session:${source}`;
  }

  async load(source: string): Promise<any | null> {
    const raw = await this.redis.get(this.key(source));
    return raw ? JSON.parse(raw) : null;
  }

  async save(source: string, context: BrowserContext): Promise<void> {
    const state = await context.storageState();
    await this.redis.set(this.key(source), JSON.stringify(state), 'EX', SESSION_TTL_SECONDS);
  }

  async clear(source: string): Promise<void> {
    await this.redis.del(this.key(source));
  }
}
```

### 7.3 `src/browser/pool.ts`

One persistent context per active board. Reused across polls — never closed unless re-auth fails.

```typescript
import { chromium } from './stealth';
import type { Browser, BrowserContext } from 'playwright';
import { SessionStore } from './session-store';
import { config } from '../config';
import { pickUserAgent } from './stealth';
import { logger } from '../observability/logger';

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();

  constructor(private sessionStore: SessionStore) {}

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: config.HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });
    logger.info('Browser launched');
  }

  async getContext(source: string, proxyUrl?: string): Promise<BrowserContext> {
    if (!this.browser) throw new Error('Browser not initialized');

    if (this.contexts.has(source)) {
      return this.contexts.get(source)!;
    }

    const storageState = await this.sessionStore.load(source);
    const ctx = await this.browser.newContext({
      userAgent: pickUserAgent(),
      viewport: { width: 1366, height: 768 },
      storageState: storageState || undefined,
      proxy: proxyUrl ? { server: proxyUrl } : undefined,
      locale: 'en-US',
      timezoneId: 'America/Toronto',
    });

    this.contexts.set(source, ctx);
    return ctx;
  }

  async resetContext(source: string): Promise<void> {
    const ctx = this.contexts.get(source);
    if (ctx) {
      await ctx.close();
      this.contexts.delete(source);
    }
    await this.sessionStore.clear(source);
  }

  async shutdown(): Promise<void> {
    for (const [source, ctx] of this.contexts.entries()) {
      try {
        await this.sessionStore.save(source, ctx);
        await ctx.close();
      } catch (e) {
        logger.warn({ err: e, source }, 'Error closing context');
      }
    }
    if (this.browser) await this.browser.close();
  }
}
```

---

## 8. DAT Adapter — Full Implementation Guide

### 8.1 Selectors

DAT will rebrand and rewire its UI. **All selectors are env-overridable.** Defaults are best-effort and must be verified against the live UI on first run.

```typescript
// src/adapters/dat/selectors.ts

export const DAT_SELECTORS = {
  // Login page
  username:        process.env.DAT_SEL_USERNAME        || 'input[name="username"], input#username, input[type="email"]',
  password:        process.env.DAT_SEL_PASSWORD        || 'input[name="password"], input#password, input[type="password"]',
  loginButton:     process.env.DAT_SEL_LOGIN_BUTTON    || 'button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")',
  mfaInput:        process.env.DAT_SEL_MFA_INPUT       || 'input[name="otp"], input[name="code"], input[autocomplete="one-time-code"]',
  loginError:      process.env.DAT_SEL_LOGIN_ERROR     || '[role="alert"], .error-message, .alert-danger',

  // Authenticated probe — element that ONLY appears when logged in
  authenticatedMarker: process.env.DAT_SEL_AUTH_MARKER || '[data-test="user-menu"], .user-profile, button:has-text("Sign Out")',

  // Search form
  equipmentDropdown: process.env.DAT_SEL_EQUIPMENT     || '[data-test="equipment-select"]',
  originInput:       process.env.DAT_SEL_ORIGIN        || 'input[name="origin"], [data-test="origin-input"]',
  destinationInput:  process.env.DAT_SEL_DESTINATION   || 'input[name="destination"], [data-test="destination-input"]',
  pickupDateFrom:    process.env.DAT_SEL_DATE_FROM     || 'input[name="pickupDateFrom"], [data-test="date-from"]',
  pickupDateTo:      process.env.DAT_SEL_DATE_TO       || 'input[name="pickupDateTo"], [data-test="date-to"]',
  searchSubmit:      process.env.DAT_SEL_SEARCH_SUBMIT || 'button[type="submit"]:has-text("Search"), [data-test="search-button"]',

  // Results table
  resultsTable:    process.env.DAT_SEL_RESULTS_TABLE   || 'table[data-test="results"], table.results-table, [role="grid"]',
  resultRow:       process.env.DAT_SEL_RESULT_ROW      || 'tr[data-test="result-row"], tbody tr',
  loadingSpinner:  process.env.DAT_SEL_LOADING         || '[data-test="loading"], .loading-spinner',

  // Per-row fields (will be combined with resultRow)
  cellLoadId:      process.env.DAT_SEL_CELL_ID         || '[data-field="id"], td:nth-child(1)',
  cellOrigin:      process.env.DAT_SEL_CELL_ORIGIN     || '[data-field="origin"]',
  cellDestination: process.env.DAT_SEL_CELL_DEST       || '[data-field="destination"]',
  cellEquipment:   process.env.DAT_SEL_CELL_EQUIPMENT  || '[data-field="equipment"]',
  cellPickupDate:  process.env.DAT_SEL_CELL_PICKUP     || '[data-field="pickupDate"]',
  cellWeight:      process.env.DAT_SEL_CELL_WEIGHT     || '[data-field="weight"]',
  cellLength:      process.env.DAT_SEL_CELL_LENGTH     || '[data-field="length"]',
  cellRate:        process.env.DAT_SEL_CELL_RATE       || '[data-field="rate"]',
  cellBroker:      process.env.DAT_SEL_CELL_BROKER     || '[data-field="broker"]',
  cellPhone:       process.env.DAT_SEL_CELL_PHONE      || '[data-field="phone"]',
} as const;
```

### 8.2 `authenticate()` — first iteration

This is the function Patrice asked for. It demonstrates the full pattern: session reuse, login flow, MFA detection, post-login verification, session persistence.

```typescript
// src/adapters/dat/login.ts

import type { BrowserContext, Page } from 'playwright';
import { config } from '../../config';
import { logger } from '../../observability/logger';
import { slackAlert } from '../../observability/slack';
import { DAT_SELECTORS } from './selectors';
import type { AuthResult } from '../base';

const LOGIN_TIMEOUT_MS = 30000;
const MFA_DETECTION_TIMEOUT_MS = 5000;

/**
 * Returns true if the current page is authenticated (i.e., the user-menu
 * marker is present). Used both to short-circuit login when a session is
 * reused and to verify success after login.
 */
async function isAuthenticated(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector(DAT_SELECTORS.authenticatedMarker, {
      timeout: 5000,
      state: 'visible',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Authenticate against DAT. Strategy:
 *   1. Open the search URL (cheap probe). If the existing session redirects
 *      us to search-not-login, we're already in. Return.
 *   2. Otherwise navigate to the login URL.
 *   3. Detect Cloudflare/captcha. If present, escalate via Slack and bail.
 *   4. Type credentials with human-like delays.
 *   5. Submit, wait for navigation.
 *   6. Detect MFA prompt. If present, escalate and bail (we don't auto-MFA).
 *   7. Detect login error. If present, return failure.
 *   8. Verify authenticated marker. Return success.
 */
export async function authenticateDAT(context: BrowserContext): Promise<AuthResult> {
  const page = await context.newPage();
  page.setDefaultTimeout(LOGIN_TIMEOUT_MS);

  try {
    // ── Step 1: Try the auth probe URL first. If session is valid, we're done.
    logger.debug({ url: config.DAT_AUTH_PROBE_URL }, 'DAT: probing existing session');
    await page.goto(config.DAT_AUTH_PROBE_URL!, { waitUntil: 'domcontentloaded' });

    if (await isAuthenticated(page)) {
      logger.info('DAT: session reused (no login needed)');
      await page.close();
      return { success: true, sessionReused: true };
    }

    // ── Step 2: Navigate to login
    logger.info('DAT: session invalid or missing, performing login');
    await page.goto(config.DAT_LOGIN_URL!, { waitUntil: 'domcontentloaded' });

    // ── Step 3: Cloudflare / captcha detection
    const captchaPresent = await page.locator('iframe[src*="cloudflare"], iframe[src*="captcha"], #cf-challenge')
      .count();
    if (captchaPresent > 0) {
      logger.warn('DAT: captcha challenge detected on login page');
      await slackAlert({
        level: 'warn',
        title: 'DAT login blocked by captcha',
        body: 'Manual intervention required. Consider rotating proxy or warming session via real browser.',
      });
      await page.close();
      return { success: false, reason: 'captcha', detail: 'Cloudflare/captcha challenge on login page' };
    }

    // ── Step 4: Fill credentials with human-like delays
    await page.waitForSelector(DAT_SELECTORS.username, { state: 'visible' });
    await humanType(page, DAT_SELECTORS.username, config.DAT_USERNAME!);
    await randomDelay(300, 800);
    await humanType(page, DAT_SELECTORS.password, config.DAT_PASSWORD!);
    await randomDelay(400, 900);

    // ── Step 5: Submit
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: LOGIN_TIMEOUT_MS }),
      page.click(DAT_SELECTORS.loginButton),
    ]);

    // ── Step 6: MFA detection
    const mfaInput = page.locator(DAT_SELECTORS.mfaInput);
    try {
      await mfaInput.waitFor({ state: 'visible', timeout: MFA_DETECTION_TIMEOUT_MS });
      logger.warn('DAT: MFA challenge detected');
      await slackAlert({
        level: 'warn',
        title: 'DAT MFA required',
        body: 'Polling paused for DAT until manual MFA completion. Run scripts/dat-manual-login.ts to refresh session.',
      });
      await page.close();
      return { success: false, reason: 'mfa_required', detail: 'MFA prompt visible' };
    } catch {
      // No MFA — continue
    }

    // ── Step 7: Check for explicit login error
    const errorEl = page.locator(DAT_SELECTORS.loginError);
    if (await errorEl.count() > 0 && await errorEl.first().isVisible()) {
      const errText = (await errorEl.first().textContent())?.trim() || 'unknown error';
      logger.error({ err: errText }, 'DAT: login rejected');
      await page.close();
      return { success: false, reason: 'invalid_credentials', detail: errText };
    }

    // ── Step 8: Verify authenticated state
    if (!(await isAuthenticated(page))) {
      logger.error('DAT: post-login verification failed (no auth marker)');
      await page.close();
      return { success: false, reason: 'unknown', detail: 'No authenticated marker after login' };
    }

    logger.info('DAT: login successful');
    await page.close();
    return { success: true, sessionReused: false };

  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, 'DAT: authentication threw');
    await page.close();
    return { success: false, reason: 'unknown', detail: err.message };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 80 });
  }
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise(r => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}
```

**Key design decisions in `authenticate()`:**

1. **Probe first, login second.** Hitting the protected URL with the existing session is one cheap request. If we're already logged in, we save 5–10 seconds of login flow and one round of suspicious traffic.
2. **Captcha → halt, do not retry.** Hammering past a captcha is the fastest way to get an account banned. Slack alert + halt for that board.
3. **MFA → halt, surface for human.** Building MFA bypass is both technically fragile and ethically dicey. Define `scripts/dat-manual-login.ts` as the operator escape hatch (Patrice runs it manually with `HEADLESS=false`, completes MFA, the session lands in Redis, scraper resumes).
4. **No exceptions thrown for known failure modes.** `AuthResult.success = false` with a typed `reason` lets the caller decide retry strategy without try/catch sprawl.
5. **Session persistence happens at the pool level**, not in `authenticate()`. After a successful login, the caller saves `context.storageState()` to Redis.

### 8.3 `search()` — implementation guide

```typescript
// src/adapters/dat/index.ts (excerpt)

async search(page: Page, query: SearchQuery): Promise<Page> {
  await page.goto(config.DAT_SEARCH_URL!, { waitUntil: 'domcontentloaded' });

  // Equipment: DAT typically uses a multi-select. Map our normalized
  // values to DAT's own labels (e.g. 'dry_van' → 'Vans, Dry').
  const datEquipmentMap: Record<string, string> = {
    dry_van:   'Vans, Dry',
    flatbed:   'Flatbeds',
    reefer:    'Vans, Reefer',
    tanker:    'Tankers',
    step_deck: 'Step Decks',
  };

  await page.click(DAT_SELECTORS.equipmentDropdown);
  for (const eq of query.equipmentTypes) {
    const label = datEquipmentMap[eq];
    if (!label) continue;
    await page.click(`text="${label}"`, { timeout: 3000 }).catch(() => {
      logger.warn({ eq }, 'DAT: equipment option not found in dropdown');
    });
  }
  await page.keyboard.press('Escape'); // close dropdown

  // Origin: enter province codes one at a time (DAT supports multi-origin).
  // For provinces, DAT typically expects '<Province>, ON' or just the province code.
  for (const prov of query.originProvinces) {
    await humanType(page, DAT_SELECTORS.originInput, prov);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }

  // Date range
  const fmt = (d: Date) => d.toISOString().split('T')[0]; // YYYY-MM-DD
  await page.fill(DAT_SELECTORS.pickupDateFrom, fmt(query.pickupDateFrom));
  await page.fill(DAT_SELECTORS.pickupDateTo,   fmt(query.pickupDateTo));

  // Submit
  await Promise.all([
    page.waitForSelector(DAT_SELECTORS.resultsTable, { timeout: 20000 }),
    page.click(DAT_SELECTORS.searchSubmit),
  ]);

  // Wait for loading spinner to disappear (if any)
  await page.locator(DAT_SELECTORS.loadingSpinner).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});

  return page;
}
```

**Notes:**
- DAT search semantics vary across DAT One vs DAT Power vs DAT iQ. Confirm the actual product Patrice's seat is on **before** assuming form structure.
- "Origin radius" and "destination radius" are listed in Patrice's brief but are typically configured *after* the city is entered. For v1 we use province-level filters and skip radius — fewer moving parts. Add radius in v1.1.
- If pagination is present, the parser handles "next page" inside `parseResult()`.

### 8.4 `parseResult()` — implementation guide

```typescript
// src/adapters/dat/parse.ts

import type { Page } from 'playwright';
import { DAT_SELECTORS } from './selectors';
import type { ParsedRow } from '../base';
import { logger } from '../../observability/logger';

const MAX_PAGES = 5; // safety cap
const MAX_ROWS_PER_RUN = 200;

export async function parseDATResults(page: Page): Promise<ParsedRow[]> {
  const all: ParsedRow[] = [];
  let pagesScraped = 0;

  while (pagesScraped < MAX_PAGES && all.length < MAX_ROWS_PER_RUN) {
    pagesScraped++;

    // Wait for the table to settle
    await page.waitForSelector(DAT_SELECTORS.resultsTable, { timeout: 10000 });

    // Extract every row in one round-trip via page.evaluate
    const rowsOnPage = await page.$$eval(DAT_SELECTORS.resultRow, (rows, sel) => {
      return rows.map(row => {
        const text = (selector: string) =>
          (row.querySelector(selector) as HTMLElement | null)?.innerText?.trim() || null;

        return {
          loadId:        text(sel.cellLoadId),
          origin:        text(sel.cellOrigin),
          destination:   text(sel.cellDestination),
          equipment:     text(sel.cellEquipment),
          pickupDate:    text(sel.cellPickupDate),
          weight:        text(sel.cellWeight),
          length:        text(sel.cellLength),
          rate:          text(sel.cellRate),
          broker:        text(sel.cellBroker),
          phone:         text(sel.cellPhone),
          rowHTML:       row.outerHTML.slice(0, 4000), // for audit / re-parse
        };
      });
    }, DAT_SELECTORS);

    // Filter rows that don't have at least loadId + origin + destination
    const valid = rowsOnPage.filter(r => r.loadId && r.origin && r.destination);
    const skipped = rowsOnPage.length - valid.length;
    if (skipped > 0) logger.debug({ skipped }, 'DAT: rows skipped (missing required fields)');

    for (const r of valid) {
      all.push({
        ...r,
        __source: 'dat',
        __scrapedAt: new Date().toISOString(),
      });
    }

    // Pagination: look for a "next" button
    const nextBtn = page.locator('button[aria-label="Next page"], a[rel="next"], button:has-text("Next")');
    const hasNext = await nextBtn.count() > 0 && await nextBtn.first().isEnabled();
    if (!hasNext) break;

    await nextBtn.first().click();
    await page.waitForTimeout(1500); // let new page load
  }

  logger.info({ rows: all.length, pages: pagesScraped }, 'DAT: parse complete');
  return all;
}
```

**Notes:**
- `rowHTML` is captured for forensic re-parsing if the schema changes. Truncated to 4 KB to bound DB size if we ever persist it.
- DAT shows phone numbers with formatting like `(555) 555-5555 ext 123`. The normalization layer (next section) cleans this.
- Rate may be `"$1,800"`, `"$1.85/mi"`, or `"Call"`. Normalization parses all three.

### 8.5 Putting it together — `DATAdapter`

```typescript
// src/adapters/dat/index.ts

import type { BrowserContext, Page } from 'playwright';
import { BaseAdapter } from '../base';
import type { AuthResult, SearchQuery, ParsedRow } from '../base';
import { authenticateDAT } from './login';
import { parseDATResults } from './parse';
import { config } from '../../config';
import { DAT_SELECTORS } from './selectors';
import { logger } from '../../observability/logger';

export class DATAdapter extends BaseAdapter {
  readonly source = 'dat' as const;

  async authenticate(context: BrowserContext): Promise<AuthResult> {
    return authenticateDAT(context);
  }

  async search(page: Page, query: SearchQuery): Promise<Page> {
    // Implementation from §8.3
    // ...
    return page;
  }

  async parseResult(page: Page): Promise<ParsedRow[]> {
    return parseDATResults(page);
  }
}
```

---

## 9. Pipeline Integration

### 9.1 Normalize: `ParsedRow` → `RawLoad`

The `RawLoad` interface is defined in T-04 (`scanner-worker.ts`). The scraper produces it identically — there is no schema fork.

```typescript
// src/pipeline/normalize.ts

import type { ParsedRow } from '../adapters/base';

export interface RawLoad {
  loadId: string;
  loadBoardSource: 'dat' | '123lb' | 'truckstop' | 'truckpath' | 'loadlink' | 'manual';
  sourceUrl: string | null;
  originCity: string;
  originState: string;
  originCountry: string;
  originLat: number | null;
  originLng: number | null;
  destinationCity: string;
  destinationState: string;
  destinationCountry: string;
  destinationLat: number | null;
  destinationLng: number | null;
  equipmentType: string;
  commodity: string | null;
  weightLbs: number | null;
  distanceMiles: number | null;
  pickupDate: string;
  pickupTimeWindow: string | null;
  deliveryDate: string | null;
  deliveryTimeWindow: string | null;
  postedRate: number | null;
  postedRateCurrency: string;
  rateType: string;
  shipperCompany: string | null;
  shipperContactName: string | null;
  shipperPhone: string | null;
  shipperEmail: string | null;
  postedAt: string;
  expiresAt: string | null;
  scannedAt: string;
}

export function normalizeDATRow(row: ParsedRow): RawLoad | null {
  if (!row.loadId || !row.origin || !row.destination) return null;

  const [originCity, originState] = parseCityState(row.origin);
  const [destCity, destState]     = parseCityState(row.destination);

  return {
    loadId: String(row.loadId),
    loadBoardSource: 'dat',
    sourceUrl: null,
    originCity:        originCity,
    originState:       originState,
    originCountry:     inferCountry(originState),
    originLat:         null,
    originLng:         null,
    destinationCity:   destCity,
    destinationState:  destState,
    destinationCountry: inferCountry(destState),
    destinationLat:    null,
    destinationLng:    null,
    equipmentType:     normalizeEquipment(row.equipment),
    commodity:         null,
    weightLbs:         parseWeight(row.weight),
    distanceMiles:     null,           // computed downstream by Mapbox if missing
    pickupDate:        parseDate(row.pickupDate),
    pickupTimeWindow:  null,
    deliveryDate:      null,
    deliveryTimeWindow: null,
    postedRate:        parseRate(row.rate),
    postedRateCurrency: 'USD',         // DAT defaults to USD; override per market if needed
    rateType:          inferRateType(row.rate),
    shipperCompany:    row.broker || null,
    shipperContactName: null,
    shipperPhone:      normalizePhone(row.phone),
    shipperEmail:      null,
    postedAt:          new Date().toISOString(),
    expiresAt:         null,
    scannedAt:         row.__scrapedAt as string,
  };
}

// ── Parsers ──────────────────────────────────────────────────

function parseCityState(s: string): [string, string] {
  // "Sudbury, ON" → ["Sudbury", "ON"]
  const parts = s.split(',').map(p => p.trim());
  if (parts.length >= 2) return [parts[0], parts[1].slice(0, 2).toUpperCase()];
  return [s.trim(), ''];
}

function inferCountry(state: string): string {
  const CA_PROVINCES = new Set(['ON','QC','BC','AB','MB','SK','NS','NB','NL','PE','YT','NT','NU']);
  if (!state) return 'US';
  return CA_PROVINCES.has(state.toUpperCase()) ? 'CA' : 'US';
}

function normalizeEquipment(s: string | null): string {
  if (!s) return 'unknown';
  const lower = s.toLowerCase();
  if (lower.includes('reefer') || lower.includes('refriger')) return 'reefer';
  if (lower.includes('flat'))   return 'flatbed';
  if (lower.includes('step'))   return 'step_deck';
  if (lower.includes('tank'))   return 'tanker';
  if (lower.includes('van') || lower.includes('dry')) return 'dry_van';
  return 'unknown';
}

function parseWeight(s: string | null): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseDate(s: string | null): string {
  if (!s) return new Date().toISOString();
  // DAT formats: "12/15", "Dec 15", "Today", "Tomorrow"
  // For brevity, simplest path is to attempt Date.parse and fall back to today.
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  if (/today/i.test(s)) return new Date().toISOString();
  if (/tomorrow/i.test(s)) {
    const t = new Date(); t.setDate(t.getDate() + 1); return t.toISOString();
  }
  return new Date().toISOString();
}

function parseRate(s: string | null): number | null {
  if (!s) return null;
  if (/call|negot/i.test(s)) return null;
  const m = s.replace(/,/g, '').match(/\$?\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function inferRateType(s: string | null): string {
  if (!s) return 'all_in';
  if (/\/mi|per\s*mi/i.test(s)) return 'per_mile';
  if (/\/km|per\s*km/i.test(s)) return 'per_km';
  return 'all_in';
}

function normalizePhone(s: string | null): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
```

### 9.2 Dedup

Two layers:

1. **Within-source dedup** at the database level: `pipeline_loads` has `UNIQUE (load_id, load_board_source)`. Insert with `ON CONFLICT DO NOTHING`. Re-posts (same load_id appearing in subsequent polls) are silently skipped.

2. **Cross-source dedup** at the application level: same shipper + same lane + same pickup date + same equipment within 24 hours = same load. Implemented exactly as T-04 §4 specifies. Run this check **before** the insert; on match, log to `scraper_log` as event `cross_source_duplicate` and skip.

```typescript
// src/pipeline/dedup.ts

import type { Pool } from 'pg';
import type { RawLoad } from './normalize';

export async function isCrossSourceDuplicate(db: Pool, load: RawLoad): Promise<boolean> {
  if (!load.shipperPhone) return false; // can't dedup without contact

  const result = await db.query(
    `SELECT id FROM pipeline_loads
       WHERE shipper_phone = $1
         AND origin_city = $2 AND origin_state = $3
         AND destination_city = $4 AND destination_state = $5
         AND DATE(pickup_date) = DATE($6)
         AND equipment_type = $7
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
    [
      load.shipperPhone,
      load.originCity, load.originState,
      load.destinationCity, load.destinationState,
      load.pickupDate,
      load.equipmentType,
    ]
  );
  return result.rowCount! > 0;
}
```

### 9.3 Database write

```typescript
// src/pipeline/db.ts

import type { Pool } from 'pg';
import type { RawLoad } from './normalize';

export async function writePipelineLoad(
  db: Pool,
  load: RawLoad,
  tenantId: number,
): Promise<{ id: number; isNew: boolean } | null> {
  const result = await db.query(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, external_load_id,
       origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date,
       equipment_type, commodity, weight_lbs, distance_miles,
       shipper_company, shipper_contact_name, shipper_phone, shipper_email,
       posted_rate, posted_rate_currency, rate_type,
       stage, stage_updated_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21, $22, 'scanned', NOW(), 'scraper-v1'
     )
     ON CONFLICT (load_id, load_board_source) DO NOTHING
     RETURNING id`,
    [
      load.loadId, load.loadBoardSource, load.loadId,
      load.originCity, load.originState, load.originCountry,
      load.destinationCity, load.destinationState, load.destinationCountry,
      load.pickupDate, load.deliveryDate,
      load.equipmentType, load.commodity, load.weightLbs, load.distanceMiles,
      load.shipperCompany, load.shipperContactName, load.shipperPhone, load.shipperEmail,
      load.postedRate, load.postedRateCurrency, load.rateType,
    ]
  );

  if (result.rowCount === 0) return null; // duplicate, skipped
  return { id: result.rows[0].id, isNew: true };
}
```

### 9.4 Enqueue to `qualify-queue`

This is the handoff to Engine 2. Same exact payload format that the API-based scanner produces.

```typescript
// src/pipeline/enqueue.ts

import { Queue } from 'bullmq';
import type { RawLoad } from './normalize';

export interface QualifyJobPayload {
  pipelineLoadId: number;
  loadId: string;
  loadBoardSource: string;
  enqueuedAt: string;
  priority: number;
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  equipmentType: string;
  postedRate: number | null;
  postedRateCurrency: string;
  distanceMiles: number;
  pickupDate: string;
  shipperPhone: string | null;
}

export function buildQualifyPayload(load: RawLoad, pipelineLoadId: number): QualifyJobPayload {
  return {
    pipelineLoadId,
    loadId: load.loadId,
    loadBoardSource: load.loadBoardSource,
    enqueuedAt: new Date().toISOString(),
    priority: load.postedRate ? Math.round(load.postedRate) : 0,
    origin: {
      city:    load.originCity,
      state:   load.originState,
      country: load.originCountry,
    },
    destination: {
      city:    load.destinationCity,
      state:   load.destinationState,
      country: load.destinationCountry,
    },
    equipmentType:      load.equipmentType,
    postedRate:         load.postedRate,
    postedRateCurrency: load.postedRateCurrency,
    distanceMiles:      load.distanceMiles ?? 0,
    pickupDate:         load.pickupDate,
    shipperPhone:       load.shipperPhone,
  };
}

export async function enqueueQualify(queue: Queue, payload: QualifyJobPayload): Promise<void> {
  await queue.add('qualify', payload, {
    priority: payload.priority,
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  });
}
```

---

## 10. Scheduler & Polling

### 10.1 `src/scheduler.ts`

```typescript
import { config } from './config';
import { logger } from './observability/logger';
import { recordRunStart, recordRunEnd } from './observability/metrics';
import { slackAlert } from './observability/slack';
import type { LoadBoardAdapter, SearchQuery } from './adapters/base';
import { BrowserPool } from './browser/pool';
import { writePipelineLoad } from './pipeline/db';
import { isCrossSourceDuplicate } from './pipeline/dedup';
import { buildQualifyPayload, enqueueQualify } from './pipeline/enqueue';
import { normalizeDATRow } from './pipeline/normalize';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';

export interface BoardConfig {
  source: 'dat' | 'truckstop' | '123lb' | 'loadlink';
  enabled: boolean;
  pollIntervalMs: number;
  jitterMs: number;
  proxyUrl?: string;
  adapter: LoadBoardAdapter;
  buildQuery: () => SearchQuery;
  normalize: (row: any) => any;
}

export class Scheduler {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private polling: Set<string> = new Set();
  private shuttingDown = false;

  constructor(
    private pool: BrowserPool,
    private db: Pool,
    private queue: Queue,
    private boards: BoardConfig[],
  ) {}

  start(): void {
    for (const board of this.boards) {
      if (!board.enabled) {
        logger.info({ source: board.source }, 'Scheduler: board disabled, skipping');
        continue;
      }
      // Initial poll on a small random delay so all boards don't fire at once
      const initialDelay = Math.random() * 30000;
      setTimeout(() => this.scheduleNext(board), initialDelay);
    }
    logger.info({ count: this.boards.filter(b => b.enabled).length }, 'Scheduler: started');
  }

  private scheduleNext(board: BoardConfig): void {
    if (this.shuttingDown) return;

    const jitter = (Math.random() * 2 - 1) * board.jitterMs; // ±jitter
    const delay = Math.max(60000, board.pollIntervalMs + jitter);

    const t = setTimeout(() => this.runPoll(board), delay);
    this.timers.set(board.source, t);
  }

  private async runPoll(board: BoardConfig): Promise<void> {
    if (!config.SCRAPER_ENABLED) {
      logger.warn({ source: board.source }, 'Scheduler: kill switch active, skipping poll');
      this.scheduleNext(board);
      return;
    }
    if (this.polling.has(board.source)) {
      logger.warn({ source: board.source }, 'Scheduler: previous poll still running, skipping');
      this.scheduleNext(board);
      return;
    }

    this.polling.add(board.source);
    const runId = await recordRunStart(this.db, board.source, config.TENANT_ID);
    const startedAt = Date.now();

    let loadsFound = 0, loadsInserted = 0, loadsDuplicates = 0, loadsSkipped = 0;
    let status: 'success' | 'partial' | 'failed' | 'auth_required' = 'success';
    let errorMessage: string | undefined;

    try {
      // Step 1: Authenticate
      const ctx = await this.pool.getContext(board.source, board.proxyUrl);
      const authResult = await board.adapter.authenticate(ctx);

      if (!authResult.success) {
        if (authResult.reason === 'mfa_required' || authResult.reason === 'captcha') {
          status = 'auth_required';
          errorMessage = `${authResult.reason}: ${authResult.detail}`;
          // Don't reschedule for these — they need human intervention
          await this.pool.resetContext(board.source);
          throw new Error(errorMessage);
        }
        throw new Error(`Auth failed: ${authResult.reason} — ${authResult.detail}`);
      }

      // Step 2: Search
      const page = await ctx.newPage();
      try {
        await board.adapter.search(page, board.buildQuery());

        // Step 3: Parse
        const rows = await board.adapter.parseResult(page);
        loadsFound = rows.length;

        // Step 4: Normalize + write
        for (const row of rows) {
          const load = board.normalize(row);
          if (!load) { loadsSkipped++; continue; }

          if (await isCrossSourceDuplicate(this.db, load)) {
            loadsDuplicates++;
            continue;
          }

          const inserted = await writePipelineLoad(this.db, load, config.TENANT_ID);
          if (!inserted) { loadsDuplicates++; continue; }

          await enqueueQualify(this.queue, buildQualifyPayload(load, inserted.id));
          loadsInserted++;
        }
      } finally {
        await page.close();
      }

      // Persist session for reuse next poll
      await this.pool['sessionStore'].save(board.source, ctx);

    } catch (err: any) {
      status = 'failed';
      errorMessage = err.message;
      logger.error({ err, source: board.source }, 'Poll failed');
      await slackAlert({
        level: 'error',
        title: `Scraper poll failed: ${board.source}`,
        body: errorMessage ?? 'Unknown error',
      });
    } finally {
      const durationMs = Date.now() - startedAt;
      await recordRunEnd(this.db, runId, {
        status, loadsFound, loadsInserted, loadsDuplicates, loadsSkipped,
        errorMessage, durationMs,
      });
      logger.info({
        source: board.source, status, loadsFound, loadsInserted, loadsDuplicates,
        loadsSkipped, durationMs,
      }, 'Poll complete');
      this.polling.delete(board.source);

      // Reschedule unless we're in auth_required state (manual intervention needed)
      if (status !== 'auth_required') this.scheduleNext(board);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.timers.values()) clearTimeout(t);
    // Wait for in-flight polls to finish (cap at 60s)
    const start = Date.now();
    while (this.polling.size > 0 && Date.now() - start < 60000) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}
```

### 10.2 Rate-limit & backoff

- **Default poll interval:** 5 minutes (DAT). With ±60 s jitter, effective range is 4–6 min. This keeps DAT under ~12 polls/hour, well below any aggressive throttle threshold.
- **Adaptive backoff:** if a poll returns 0 new loads three times in a row, double the interval (capped at 30 min). Reset on first successful poll with new loads.
- **HTTP 429 / soft block detection:** if `parseResult()` returns zero rows AND the page contains text like "rate limit", "too many requests", or "please slow down" → halt that board for 30 min and Slack-alert.

---

## 11. Observability

### 11.1 Logger

`pino` with structured JSON. One field: `service: 'myra-scraper'`. Railway captures stdout natively.

### 11.2 Slack alerts

```typescript
// src/observability/slack.ts

import { config } from '../config';
import { logger } from './logger';

interface SlackAlertPayload {
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
}

const COLORS = { info: '#36a64f', warn: '#ff9900', error: '#ff0000' };

export async function slackAlert(payload: SlackAlertPayload): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) return;

  try {
    await fetch(config.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color:  COLORS[payload.level],
          title:  `[Myra Scraper] ${payload.title}`,
          text:   payload.body,
          ts:     Math.floor(Date.now() / 1000),
        }],
      }),
    });
  } catch (e) {
    logger.warn({ err: e }, 'Slack alert failed');
  }
}
```

**When to alert:**
- ❗ `error` — auth failure (other than session-reuse), poll exception, three consecutive failed polls
- ⚠️ `warn` — captcha detected, MFA required, soft rate-limit detected, 0 loads for 30 min
- ℹ️ `info` — daily digest at 09:00 ET (loads today, success rate, sources active)

### 11.3 `scraper_runs` & `scraper_log`

Every poll cycle inserts one `scraper_runs` row at start (status=running), updates it at end. Granular events go to `scraper_log` with `run_id` foreign key.

```typescript
// src/observability/metrics.ts

import type { Pool } from 'pg';

export async function recordRunStart(db: Pool, source: string, tenantId: number): Promise<number> {
  const r = await db.query(
    `INSERT INTO scraper_runs (source, tenant_id, status) VALUES ($1, $2, 'running') RETURNING id`,
    [source, tenantId],
  );
  return r.rows[0].id;
}

interface RunEnd {
  status: 'success' | 'partial' | 'failed' | 'auth_required';
  loadsFound: number;
  loadsInserted: number;
  loadsDuplicates: number;
  loadsSkipped: number;
  errorMessage?: string;
  durationMs: number;
}

export async function recordRunEnd(db: Pool, runId: number, end: RunEnd): Promise<void> {
  await db.query(
    `UPDATE scraper_runs
        SET completed_at = NOW(),
            status = $2,
            loads_found = $3,
            loads_inserted = $4,
            loads_duplicates = $5,
            loads_skipped = $6,
            error_message = $7,
            duration_ms = $8
      WHERE id = $1`,
    [runId, end.status, end.loadsFound, end.loadsInserted, end.loadsDuplicates,
     end.loadsSkipped, end.errorMessage ?? null, end.durationMs],
  );
}
```

### 11.4 Daily metrics query (operator dashboard)

```sql
-- "How is the scraper doing today?"
SELECT
  source,
  COUNT(*)                                   AS runs,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful,
  SUM(loads_inserted)                        AS new_loads,
  SUM(loads_duplicates)                      AS duplicates,
  AVG(duration_ms)::int                      AS avg_ms,
  MAX(completed_at)                          AS last_completed
FROM scraper_runs
WHERE started_at > CURRENT_DATE
GROUP BY source
ORDER BY new_loads DESC;
```

---

## 12. Stub Adapters (Truckstop, 123Loadboard, Loadlink)

Each stub is a working file that compiles and is registered in the scheduler, but throws `NotImplementedError` if `*_ENABLED=true` is set without an implementation. This guarantees the abstraction is real (won't be caught later breaking when a fourth adapter is added).

```typescript
// src/adapters/truckstop/index.ts (representative stub)

import type { BrowserContext, Page } from 'playwright';
import { BaseAdapter } from '../base';
import type { AuthResult, SearchQuery, ParsedRow } from '../base';

export class TruckstopAdapter extends BaseAdapter {
  readonly source = 'truckstop' as const;

  async authenticate(_context: BrowserContext): Promise<AuthResult> {
    throw new Error('TruckstopAdapter.authenticate() not yet implemented');
  }
  async search(_page: Page, _query: SearchQuery): Promise<Page> {
    throw new Error('TruckstopAdapter.search() not yet implemented');
  }
  async parseResult(_page: Page): Promise<ParsedRow[]> {
    throw new Error('TruckstopAdapter.parseResult() not yet implemented');
  }
}
```

Identical pattern for `LoadBoard123Adapter` and `LoadlinkAdapter`. All three follow the same selectors / login / search / parse structure as DAT — when their turn comes, the build is mostly a copy-paste with new selectors.

---

## 13. Deployment

### 13.1 `Dockerfile`

```dockerfile
# Use Microsoft's Playwright image — comes with browsers + system deps preinstalled
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install dependencies first (cache-friendly)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Don't run as root
USER pwuser

ENV NODE_ENV=production
ENV HEADLESS=true

CMD ["node", "dist/index.js"]
```

### 13.2 Railway deployment

1. Create a new Railway project: `myra-scraper`
2. Connect the `/scraper` directory as the service root (or use a separate repo if cleaner)
3. Add env vars from `.env.example` (set `DAT_PASSWORD` etc. as **secrets**, not plain env)
4. Connect to the same Neon database via `DATABASE_URL` and Upstash Redis via `REDIS_URL`
5. Health check: optional. The scheduler logs heartbeats to stdout; Railway's process monitoring is sufficient
6. Memory: 512 MB minimum. Bump to 1 GB if running 2+ boards concurrently
7. Region: pick the same region as Neon/Upstash to minimize latency

### 13.3 Why not Vercel

Vercel functions max out at 5 minutes (Pro: 15 min). Browser context warm-up takes 2–4 seconds. Login flow takes 8–15 seconds. Search + parse takes another 5–10 seconds. **Total: 15–30 seconds per poll.** A 5-minute serverless budget is technically enough for one poll — but warm-up cost per invocation is wasteful, and you can't keep a session warm in Redis without paying the warm-up tax every time. Long-running worker is cheaper and faster.

### 13.4 Local development

```bash
# Install
npm install

# Install browsers (first time only)
npx playwright install chromium

# Run with debug UI
HEADLESS=false LOG_LEVEL=debug npm run dev
```

---

## 14. Testing Strategy

### 14.1 Parser unit tests (must-have for tonight)

Snapshot DAT search results to `test/fixtures/dat-results.html`. Parse → assert structure. This protects against UI changes — when DAT redesigns, the test fails immediately.

```typescript
// test/parse.test.ts

import { test, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { parseDATResults } from '../src/adapters/dat/parse';

// Build a Page-like adapter over JSDOM for parser unit tests
// (parseResult uses page.$$eval — abstract this behind a smaller fn for testability)

test('DAT parser extracts loads from real fixture', async () => {
  const html = readFileSync('test/fixtures/dat-results.html', 'utf-8');
  // ... wire up JSDOM / Playwright fixtures
  // const rows = await parseDATResultsFromHTML(html);
  // expect(rows.length).toBeGreaterThan(0);
  // expect(rows[0]).toHaveProperty('loadId');
});
```

### 14.2 Integration test (deferred — post-tonight)

End-to-end: real DAT login → search → parse → write → enqueue → assert qualify-queue has new jobs. Run weekly against a staging DB.

### 14.3 Smoke test (run after deploy)

```bash
# After deploy, verify the pipeline is moving
psql $DATABASE_URL -c "SELECT source, COUNT(*) FROM scraper_runs WHERE started_at > NOW() - INTERVAL '15 min' GROUP BY source;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM pipeline_loads WHERE created_by = 'scraper-v1' AND created_at > NOW() - INTERVAL '15 min';"
```

---

## 15. Build Sequence — 4.5 Hours

**The order matters.** Every step builds on the prior one. Don't skip ahead.

| Block | Time | Task | Success criteria |
|---|---|---|---|
| **Bootstrap** | 0:00–0:25 | Repo scaffold, `package.json`, `tsconfig`, `Dockerfile`, `.env.example`, install deps, `playwright install chromium` | `npm run build` succeeds |
| **DB migration** | 0:25–0:50 | Write `001_scraper_tables.sql`, run against Neon, verify both tables exist | `\dt scraper_*` shows both tables |
| **Config + logger + Slack** | 0:50–1:10 | `src/config.ts` (zod), `src/observability/logger.ts`, `src/observability/slack.ts`, simple "hello world" boot | App boots, logs structured JSON, sends test Slack message |
| **Browser pool + session store** | 1:10–1:40 | `src/browser/stealth.ts`, `src/browser/session-store.ts`, `src/browser/pool.ts`, manual sanity test (open google.com headless, screenshot) | Screenshot captured, no crashes |
| **DAT authenticate()** | 1:40–2:25 | `src/adapters/dat/selectors.ts`, `src/adapters/dat/login.ts`, run against real DAT login with `HEADLESS=false` | `authResult.success === true` against live DAT, session persists in Redis |
| **DAT search() + parseResult()** | 2:25–3:15 | `src/adapters/dat/index.ts` (search) + `src/adapters/dat/parse.ts`, parser test against real result page | At least 10 rows parsed with valid loadId/origin/destination |
| **Pipeline integration** | 3:15–3:50 | `normalize.ts`, `dedup.ts`, `db.ts`, `enqueue.ts` — wire the parser output into `pipeline_loads` and `qualify-queue` | New rows visible in `pipeline_loads`, jobs visible in `qualify-queue` (`bullmq-board` or Redis CLI) |
| **Scheduler + observability** | 3:50–4:15 | `src/scheduler.ts`, `src/observability/metrics.ts`, `src/index.ts` (entry), full lifecycle works | Scheduler runs poll, writes to `scraper_runs`, posts Slack on intentional error |
| **Stubs + README + deploy** | 4:15–4:30 | Three stub adapters (5 min), `README.md` (5 min), Railway push (5 min) | Service running on Railway, polling DAT, loads moving |

**If you fall behind:** drop in this order — (1) integration test, (2) parser unit test, (3) stub adapters. Never drop database migration, scheduler, or observability. A scraper that runs without observability is a black box you can't debug at 2 AM.

---

## 16. Operator Runbook (post-deploy)

### 16.1 First 24 hours — what to watch

- Slack channel `#myra-scraper` for any error/warn alerts
- `SELECT COUNT(*) FROM scraper_runs WHERE source = 'dat' AND status = 'success' AND started_at > NOW() - INTERVAL '1 hour';` should be ≥10 (one per ~5 min minus any gaps)
- `SELECT COUNT(*) FROM pipeline_loads WHERE created_by = 'scraper-v1' AND created_at > NOW() - INTERVAL '1 hour';` should be > 0
- Engine 2's qualifier worker should be processing jobs — check `agent_jobs` for `qualify-queue` activity

### 16.2 Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `auth_required` Slack alert | DAT requested MFA | Run `npm run dat:manual-login` locally, complete MFA, session re-saves |
| 0 loads for 30 min | DAT changed selectors OR captcha challenge | Inspect screenshot from `/tmp`, update selectors via env, redeploy |
| Process restarts every 5 min | OOM | Bump Railway memory to 1 GB |
| Cross-source duplicates exploding | Wrong shipper_phone normalization | Audit `normalizePhone()` against actual DAT phone formats |
| Captcha alerts increasing | Pattern detection — too aggressive polling | Increase `DAT_POLL_INTERVAL_MS` to 600000 (10 min), add proxy |

### 16.3 Manual MFA refresh script

```typescript
// scripts/dat-manual-login.ts
// Run with HEADLESS=false to interact with the browser yourself.
// Complete MFA in the visible browser; the script saves the session to Redis.

import { chromium } from '../src/browser/stealth';
import { SessionStore } from '../src/browser/session-store';
import IORedis from 'ioredis';
import { config } from '../src/config';

async function main() {
  const redis = new IORedis(config.REDIS_URL);
  const store = new SessionStore(redis);

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(config.DAT_LOGIN_URL!);
  console.log('Browser is open. Complete login + MFA, then press Enter in this terminal.');
  process.stdin.once('data', async () => {
    await store.save('dat', ctx);
    console.log('Session saved to Redis.');
    await browser.close();
    await redis.quit();
    process.exit(0);
  });
}
main();
```

---

## 17. README Content

The `README.md` in `/scraper` should contain:

1. One-paragraph purpose statement (this is a **bridge layer**)
2. Quick start (4 commands: clone → install → env → start)
3. Link back to T-04 (canonical Scanner spec) and T-04A (this doc)
4. Operator runbook (lift §16 from this doc)
5. Pointer to migration script
6. Deploy instructions (Railway 5-step)

Keep it under 200 lines. Don't duplicate the spec.

---

## 18. Acceptance Criteria

Tonight's session is **complete** when all of these are true:

- [ ] `/scraper` directory exists with the structure in §3
- [ ] `migrations/001_scraper_tables.sql` has been run; `scraper_runs` and `scraper_log` exist in Neon
- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm run dev` (locally) successfully authenticates against DAT and persists a session to Redis
- [ ] At least one full poll cycle completes end-to-end against real DAT, producing ≥10 rows in `pipeline_loads` with `created_by = 'scraper-v1'`
- [ ] Each of those rows has a corresponding job in `qualify-queue` (verifiable via BullMQ Board or `LRANGE bull:qualify-queue:wait 0 -1` on Redis)
- [ ] Engine 2 Qualifier worker picks up at least one of those jobs and advances it to `qualified` or `disqualified`
- [ ] Slack receives at least one info-level "scraper started" message
- [ ] Service is deployed to Railway with all secrets set
- [ ] First production poll on Railway succeeds (visible in `scraper_runs`)
- [ ] Stub files exist for Truckstop, 123Loadboard, Loadlink — all throw `NotImplementedError` cleanly when called

**Non-goals for tonight (explicitly out of scope):**

- Truckstop / 123LB / Loadlink working implementations
- Distance computation via Mapbox (deferred to scanner-worker.ts when API access lands)
- Pagination beyond 5 pages
- Rate intelligence parsing (per-mile vs all-in heuristics beyond the basic `inferRateType`)
- Automated MFA bypass (will not be built — design choice)
- Web UI for scraper status (read directly from `scraper_runs` table for now)

---

## 19. Hand-off Notes for Claude Code Pro Max

When loading this spec into Claude Code, prepend the session with:

> **Context:** You are building T-04A — the headless browser load board scanner — a fallback for the Scanner Agent (T-04) while official load board API access is pending. The full spec is in this document. Existing infrastructure (Neon DB, Upstash Redis, BullMQ qualify-queue, pipeline_loads table) is already deployed and operational. You are extending an existing system, not building from scratch. Read the spec end-to-end before writing any code. Implement in the order defined in §15. Stop at every "Success criteria" checkpoint and verify before continuing.
>
> **Hard rules:**
> 1. Do not fork the `RawLoad` schema. It must match T-04 exactly so loads are indistinguishable downstream.
> 2. Do not modify `pipeline_loads` schema. Use only the additive `scraper_runs` and `scraper_log` tables.
> 3. Do not bypass MFA programmatically. Surface and halt.
> 4. Do not skip the cross-source dedup check.
> 5. All env vars validated via zod at boot. No silent defaults for credentials.
> 6. Every Slack alert ends up in `scraper_log` AS WELL — Slack is for humans, the table is for forensics.
>
> **When in doubt:** ship the simplest thing that meets the acceptance criteria. This is a bridge layer with a 60-day shelf life. Don't over-engineer.

---

*End of T-04A. This document supersedes any verbal scope on the headless scanner. Update version and date on any material change.*
