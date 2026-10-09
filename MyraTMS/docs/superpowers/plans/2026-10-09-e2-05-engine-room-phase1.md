# E2-05 Phase 1 — Runtime control layer (Railway first)

**Goal.** Move Engine 2's kill switches out of `process.env` and into a versioned, tenant-scoped, auditable `engine_config` row that the Railway workers read every ≤5 seconds and fail closed on. Add the three tables the Engine Room UI needs in order to *do* anything (`engine_commands`, `worker_heartbeats`, `call_batches`) plus the one missing consumer (`callback-queue`) that makes the UI's `schedule_callback` control truthful. No UI in this phase. No Engine 3 coupling in this phase.

**Architecture.** Vercel writes desired state (`engine_config` via a validated writer, `engine_commands` rows). Railway reads desired state and is the only thing that dials. The seam is the database — there is no RPC from Vercel to Railway, and there will not be one. A new `lib/engine-room/` module owns the config schema, the reader, the writer and the command vocabulary; `lib/workers/` consumes the reader and gains two workers (`command-worker`, `callback-worker`); `scripts/run-workers.ts` gains a heartbeat writer.

**Tech stack.** Neon serverless Postgres via `lib/pipeline/db-adapter.ts` (`db.query(text, params)`), BullMQ on ioredis via `lib/pipeline/redis-bullmq.ts`, `BaseWorker` from `lib/workers/base-worker.ts`, Pino via `lib/logger.ts`, vitest 4 against the persistent Neon `dev-tests` branch.

**Spec.** The operator's E2-05 prompt, Phase 1 section, as amended by the 2026-10-09 decisions: `schedule_callback` ships in V1 with a real consumer; roles come from the existing `tenant_users.role` CHECK vocabulary and nothing new is invented; Engine 3 disagreements return an empty list in V1 (Phase 3 concern, not this one).

**Phase 0 facts this plan depends on** (all from `docs/E2-05_phase0_report.md`):
- `MAX_CONCURRENT_CALLS` defaults to `'1'` in `voice-worker.ts:101`, so *unset* means live dialing, not shadow.
- `voice-worker.ts` tests `Number(...) <= 0`; `compiler-worker.ts:143` tests `=== '0'`. They disagree.
- `callback-queue` and `escalation-queue` have producers in `retell-webhook.ts` and **no consumers**.
- No heartbeat is persisted anywhere; `run-workers.ts:167` only `logger.debug`s.
- No batch entity exists. `call_budget` and `v_pipeline_funnel_daily` do not exist.
- `carrier-voice-worker.ts:102` and `dispatcher-worker.ts:144` read their flags **once, in the constructor** — a config change cannot reach them without a restart until this phase fixes that.
- Railway's `DATABASE_URL` is still `neondb_owner`; Vercel's is `myra_app`. New tables need explicit grants or Vercel gets `permission denied`.
- `scripts/run-migration.ts` splits SQL on `;`, so no `$$ … $$` bodies in the migration.

---

## Global constraints

1. **Branch.** All work on `e2-05-engine-room`, cut from `master`. One PR per phase. Nothing pushed to `master`.
2. **Fail closed, explicitly.** Every config read that cannot produce a validated config returns `calling_enabled: false, pipeline_enabled: false`. No `Number(process.env.X)`. Parsing is a named function that returns `{ ok: true, value } | { ok: false, reason }`.
3. **Engine 3 stays shadow.** `evaluateAuthority` must not appear in any file under `lib/workers/`. A test asserts this.
4. **Do not touch** `lib/pipeline/retell-webhook.ts` conversation logic, the Retell agent configs, the negotiation brief schema, or `lib/exceptions/detector.ts`'s eight rules. The callback consumer reads the payload the webhook already produces; it does not change the producer.
5. **No backfill on live tables.** `agent_calls.batch_id` and `agent_jobs.batch_id` are added nullable with no `UPDATE`.
6. **Grants.** Every new table gets `GRANT SELECT, INSERT, UPDATE ON … TO myra_app` plus sequence usage, in the same migration.
7. **Tenant id is never hardcoded.** `getMyraTenantId()` or an explicit parameter.
8. **Tests are DB-backed** against `dev-tests`, following `__tests__/pipeline/carrier-voice-worker.test.ts`. Every test cleans its own rows by a `TEST-E205-` prefix or a captured id.
9. **Migration is not applied to production in this phase.** Apply to `dev-tests` only. Production apply is a separate, explicitly confirmed step.

---

## Review focus — five failure modes the task list must cover and the obvious tests will not catch

1. **The 5-second cache makes emergency stop a lie.** A worker that caches for 5s and holds a 100-deep BullMQ concurrency window can start dozens of calls after the stop was written. Emergency stop must therefore *not* rely on the cache expiring: the command path must also set a Redis flag the dial gate checks synchronously, and `getEngineConfig` must bypass its cache when that flag is set. Task 6 covers this; Task 13 proves the <30s bound with real timing.
2. **Fail-closed can itself be the outage.** If Neon has a transient blip, every worker simultaneously flips to `calling_enabled: false` and raises an exception row — 10 workers × an exception each, repeatedly. The reader must serve the *last known good* config for a bounded grace window (30s) on read error before failing closed, and must dedupe the exception by a stable `type` + open-state check. Task 5.
3. **The audit diff lies if the writer reads outside the transaction.** Two concurrent writes both read version 7, both write version 8. The version column must be unique per tenant and the writer must insert `(tenant_id, version)` with the version derived inside the same statement, so the loser gets a constraint violation rather than a silently lost update. Task 7.
4. **A command worker that is "idempotent" by `status != 'pending'` is not.** Two command workers (or one restarted mid-flight) can both claim a row. Claiming must be a single `UPDATE … WHERE status = 'pending' RETURNING *` and the worker must act only on returned rows. Task 9.
5. **The callback consumer can resurrect a dead load.** `retell-webhook` enqueues a callback with a delay of up to hours. By the time it fires, the load may be `expired`, `declined` or already `booked`. The consumer must re-validate stage *and* re-run compliance (DNC + calling hours) before re-enqueueing to `call-queue`, or Phase 1 ships a mechanism that cold-calls a shipper who asked to be left alone. Task 11.

---

## File structure

```
MyraTMS/
  scripts/
    062_engine_room_runtime_control.sql          # new
    062_engine_room_runtime_control_rollback.sql # new
    apply-062-engine-room.ts                     # new (semicolon-split safe)
    seed-engine-config.ts                        # new
  lib/engine-room/
    config-schema.ts     # new — key table, defaults, parsers, validators
    config-reader.ts     # new — getEngineConfig(tenantId), cache, fail-closed
    config-writer.ts     # new — writeEngineConfig(), versioned + audited
    commands.ts          # new — command vocabulary + claim/complete helpers
    heartbeat.ts         # new — upsertHeartbeat(), listWorkerHealth()
  lib/workers/
    command-worker.ts    # new — Railway command executor
    callback-worker.ts   # new — callback-queue consumer
    voice-worker.ts              # modified — read config, not env
    carrier-voice-worker.ts      # modified — per-job read, not constructor
    dispatcher-worker.ts         # modified — per-job read
    shipper-confirmation-worker.ts # modified — per-job read
    compiler-worker.ts           # modified — shadow test via config
  scripts/run-workers.ts # modified — boot command + callback workers, heartbeat
  __tests__/engine-room/
    config-schema.test.ts
    config-reader.test.ts
    config-writer.test.ts
    command-worker.test.ts
    callback-worker.test.ts
    emergency-stop.test.ts
    engine3-isolation.test.ts
```

---

## Task 1 — Branch

```bash
cd MyraTMS && git checkout -b e2-05-engine-room
```

Nothing else. The Phase 0 report stays uncommitted per the operator.

**Verify:** `git branch --show-current` → `e2-05-engine-room`.

---

## Task 2 — Migration 062 (schema only, no logic)

`scripts/062_engine_room_runtime_control.sql`. Plain DDL, no `$$` bodies, so `run-migration.ts` can split it safely — but we use the `apply-062` script anyway for the verification read-back.

```sql
-- 062_engine_room_runtime_control.sql
-- E2-05 Phase 1: runtime control layer for Engine 2 + Engine Room UI.
-- Tenant-scoped, versioned, auditable. Railway reads; Vercel writes desired state.

CREATE TABLE IF NOT EXISTS engine_config (
  id                              BIGSERIAL PRIMARY KEY,
  tenant_id                       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version                         INTEGER NOT NULL,
  is_current                      BOOLEAN NOT NULL DEFAULT true,

  -- master switches
  pipeline_enabled                BOOLEAN NOT NULL DEFAULT false,
  calling_enabled                 BOOLEAN NOT NULL DEFAULT false,
  scanner_enabled                 BOOLEAN NOT NULL DEFAULT false,

  -- concurrency + ramp
  max_concurrent_calls            INTEGER NOT NULL DEFAULT 0,
  ramp_cap_calls_per_hour         INTEGER NOT NULL DEFAULT 0,
  max_calls_per_phone_per_day     INTEGER NOT NULL DEFAULT 1,

  -- calling hours (local to the called party's tz, as voice-worker already assumes)
  calling_hours_start             SMALLINT NOT NULL DEFAULT 8,
  calling_hours_end               SMALLINT NOT NULL DEFAULT 20,

  -- sell-side switches (mirror the existing env flags 1:1)
  carrier_calls_enabled           BOOLEAN NOT NULL DEFAULT false,
  carrier_auto_assign_enabled     BOOLEAN NOT NULL DEFAULT false,
  shipper_confirmation_enabled    BOOLEAN NOT NULL DEFAULT false,
  inbound_email_polling_enabled   BOOLEAN NOT NULL DEFAULT false,

  -- shipper-direct gate (E2-01)
  shipper_direct_gate_enabled     BOOLEAN NOT NULL DEFAULT true,
  shipper_direct_gate_mode        TEXT NOT NULL DEFAULT 'shadow'
                                  CHECK (shipper_direct_gate_mode IN ('shadow','enforce')),

  -- callback behaviour (new in V1 because schedule_callback ships)
  callbacks_enabled               BOOLEAN NOT NULL DEFAULT false,
  callback_max_attempts           SMALLINT NOT NULL DEFAULT 2,

  -- safety brake
  error_rate_brake_enabled        BOOLEAN NOT NULL DEFAULT true,
  error_rate_brake_threshold_pct  SMALLINT NOT NULL DEFAULT 25,
  error_rate_brake_window_minutes SMALLINT NOT NULL DEFAULT 15,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                      TEXT,

  CONSTRAINT engine_config_version_uq UNIQUE (tenant_id, version),
  CONSTRAINT engine_config_concurrency_ck CHECK (max_concurrent_calls >= 0 AND max_concurrent_calls <= 50),
  CONSTRAINT engine_config_ramp_ck CHECK (ramp_cap_calls_per_hour >= 0 AND ramp_cap_calls_per_hour <= 500),
  CONSTRAINT engine_config_phone_cap_ck CHECK (max_calls_per_phone_per_day >= 1),
  CONSTRAINT engine_config_hours_ck CHECK (
    calling_hours_start >= 8 AND calling_hours_end <= 20 AND calling_hours_start < calling_hours_end
  ),
  CONSTRAINT engine_config_brake_ck CHECK (
    error_rate_brake_threshold_pct BETWEEN 1 AND 100
    AND error_rate_brake_window_minutes BETWEEN 1 AND 240
  )
);

-- exactly one current row per tenant
CREATE UNIQUE INDEX IF NOT EXISTS engine_config_current_uq
  ON engine_config (tenant_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS engine_config_audit (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  changed_by  TEXT NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  diff        JSONB NOT NULL,
  reason      TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('ui','brake','emergency_stop','seed')),
  CONSTRAINT engine_config_audit_reason_ck CHECK (length(btrim(reason)) >= 3)
);

CREATE INDEX IF NOT EXISTS engine_config_audit_tenant_idx
  ON engine_config_audit (tenant_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS engine_commands (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  command_type   TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','succeeded','failed','expired')),
  requested_by   TEXT NOT NULL,
  reason         TEXT,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at     TIMESTAMPTZ,
  claimed_by     TEXT,
  completed_at   TIMESTAMPTZ,
  result         JSONB,
  error_message  TEXT,
  idempotency_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS engine_commands_idem_uq
  ON engine_commands (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS engine_commands_pending_idx
  ON engine_commands (status, requested_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_name    TEXT PRIMARY KEY,
  host_id        TEXT NOT NULL,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  config_version INTEGER,
  config_source  TEXT,
  queue_name     TEXT,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS call_batches (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS call_batches_tenant_idx ON call_batches (tenant_id, created_at DESC);

-- nullable, no backfill: these are live tables
ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES call_batches(id);
ALTER TABLE agent_jobs  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES call_batches(id);

CREATE INDEX IF NOT EXISTS agent_calls_batch_idx ON agent_calls (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_jobs_batch_idx  ON agent_jobs  (batch_id) WHERE batch_id IS NOT NULL;

-- Vercel runs as myra_app (migration 061). Without these it gets permission denied.
GRANT SELECT, INSERT, UPDATE ON engine_config, engine_commands,
      worker_heartbeats, call_batches TO myra_app;
-- append-only: insert and read, never update or delete, not even for the app role
GRANT SELECT, INSERT ON engine_config_audit TO myra_app;
REVOKE UPDATE, DELETE ON engine_config_audit FROM myra_app;
GRANT USAGE, SELECT ON SEQUENCE engine_config_id_seq, engine_config_audit_id_seq,
      engine_commands_id_seq, call_batches_id_seq TO myra_app;
```

Rollback mirrors it in reverse (drop the two columns, drop the five tables, no `CASCADE` on `tenants`).

`scripts/apply-062-engine-room.ts` follows the existing `apply-0XX-*.ts` pattern: read the file, split on `;\n`, execute each statement, then read back `to_regclass` for all five tables plus `information_schema.columns` for the two new columns, and print a PASS/FAIL table.

**Test** (`__tests__/engine-room/migration-062.test.ts`): asserts all five tables exist, that the partial unique index rejects a second `is_current` row for the same tenant, that `calling_hours_start = 7` violates the check, that `max_calls_per_phone_per_day = 0` violates the check, and that a `reason` of `'  '` violates the audit check.

**Verify:** `pnpm tsx --env-file=.env.local scripts/apply-062-engine-room.ts` against `dev-tests`, then the test file green.

---

## Task 3 — `lib/engine-room/config-schema.ts`

The single source of truth for keys, defaults, types and parsing. **Write the test first.**

```ts
// lib/engine-room/config-schema.ts
export type EngineConfigSource = 'env' | 'shadow' | 'db';

export interface EngineConfig {
  tenantId: number;
  version: number;
  pipelineEnabled: boolean;
  callingEnabled: boolean;
  scannerEnabled: boolean;
  maxConcurrentCalls: number;
  rampCapCallsPerHour: number;
  maxCallsPerPhonePerDay: number;
  callingHoursStart: number;
  callingHoursEnd: number;
  carrierCallsEnabled: boolean;
  carrierAutoAssignEnabled: boolean;
  shipperConfirmationEnabled: boolean;
  inboundEmailPollingEnabled: boolean;
  shipperDirectGateEnabled: boolean;
  shipperDirectGateMode: 'shadow' | 'enforce';
  callbacksEnabled: boolean;
  callbackMaxAttempts: number;
  errorRateBrakeEnabled: boolean;
  errorRateBrakeThresholdPct: number;
  errorRateBrakeWindowMinutes: number;
  /** provenance, for the UI and for heartbeats */
  source: EngineConfigSource;
  /** true when this config is the fail-closed fallback, not a real read */
  degraded: boolean;
}

/** The fail-closed config. Everything that can place a call or pull work is off. */
export function failClosedConfig(tenantId: number, source: EngineConfigSource): EngineConfig { /* … */ }

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Exact-match boolean. No coercion. '' / undefined / 'yes' / '1' are all errors, not false. */
export function parseBoolFlag(raw: string | undefined, key: string): Parsed<boolean> {
  if (raw === undefined) return { ok: false, reason: `${key} is unset` };
  const v = raw.trim().toLowerCase();
  if (v === 'true') return { ok: true, value: true };
  if (v === 'false') return { ok: true, value: false };
  return { ok: false, reason: `${key}=${JSON.stringify(raw)} is not 'true' or 'false'` };
}

/** Explicit integer parse. Rejects '', NaN, floats, out-of-range. Replaces Number(process.env.X). */
export function parseIntFlag(
  raw: string | undefined, key: string, min: number, max: number,
): Parsed<number> {
  if (raw === undefined) return { ok: false, reason: `${key} is unset` };
  const v = raw.trim();
  if (!/^-?\d+$/.test(v)) return { ok: false, reason: `${key}=${JSON.stringify(raw)} is not an integer` };
  const n = Number.parseInt(v, 10);
  if (n < min || n > max) return { ok: false, reason: `${key}=${n} outside [${min},${max}]` };
  return { ok: true, value: n };
}

/** Build a config from process.env for ENGINE_CONFIG_SOURCE=env|shadow. Any failure ⇒ fail closed. */
export function configFromEnv(tenantId: number): { config: EngineConfig; errors: string[] } { /* … */ }

/** Map a raw engine_config row (Neon: BIGINT ⇒ string) to EngineConfig. */
export function rowToConfig(row: Record<string, unknown>, source: EngineConfigSource): EngineConfig { /* … */ }

/** Field-by-field comparison for the ENGINE_CONFIG_SOURCE=shadow parity log. */
export function diffConfigs(a: EngineConfig, b: EngineConfig): Record<string, [unknown, unknown]> { /* … */ }
```

**Test** (`config-schema.test.ts`), pure, no DB:
- `parseIntFlag('', 'MAX_CONCURRENT_CALLS', 0, 50)` → `ok: false`. **This is the specific coincidence the operator called out: `Number('') === 0` used to read as "shadow mode".**
- `parseIntFlag('abc', …)` → `ok: false`. Today `Number('abc')` is `NaN` and `NaN <= 0` is `false`, so this value currently means *dial*.
- `parseIntFlag('1.5', …)` → `ok: false`.
- `parseIntFlag(undefined, …)` → `ok: false` (today it defaults to `'1'` ⇒ live).
- `parseBoolFlag('true\n', …)` → `true` (the trailing-newline footgun the root CLAUDE.md documents).
- `parseBoolFlag('1', …)` → `ok: false`.
- `configFromEnv` with an empty env returns `degraded: true`, `callingEnabled: false`, `pipelineEnabled: false`, and a non-empty `errors` array naming every missing key.
- `failClosedConfig` has `maxConcurrentCalls === 0` and every `*Enabled` false **except** `shipperDirectGateEnabled`, which fails closed by being *on* (the gate's safe state is enforcing, not permitting).

---

## Task 4 — Audit the current env read sites into a fixture

Before changing any worker, capture today's behaviour as a table in the test file so the migration is provably behaviour-preserving when the config matches the env. A small test that imports nothing from the workers, just documents expected mappings:

| env var | current read site | current default | config field |
|---|---|---|---|
| `PIPELINE_ENABLED` | `voice-worker.ts:96`, 4 Vercel sites | unset ⇒ off | `pipelineEnabled` |
| `MAX_CONCURRENT_CALLS` | `voice-worker.ts:101`, `compiler-worker.ts:143` | unset ⇒ `1` ⇒ **live** | `maxConcurrentCalls` |
| `CARRIER_CALLS_ENABLED` | `carrier-voice-worker.ts:102` (ctor) | unset ⇒ off | `carrierCallsEnabled` |
| `CARRIER_AUTO_ASSIGN_ENABLED` | `dispatcher-worker.ts:144` (ctor) | unset ⇒ off | `carrierAutoAssignEnabled` |
| `SHIPPER_CONFIRMATION_ENABLED` | `shipper-confirmation-worker.ts:139` | unset ⇒ off | `shipperConfirmationEnabled` |
| `SCANNER_ENABLED` | Vercel scan cron | unset ⇒ off | `scannerEnabled` |
| `SHIPPER_DIRECT_GATE_ENABLED/_MODE` | `load-source-classifier.ts` | unset ⇒ off / shadow | `shipperDirectGate*` |
| hardcoded `hour < 8 \|\| hour >= 20` | `voice-worker.ts:173` | n/a | `callingHours*` |

**Verify:** no code change; the table lands as a doc comment at the top of `config-schema.ts` so the next session does not have to re-derive it.

---

## Task 5 — `getEngineConfig(tenantId)` reader

```ts
// lib/engine-room/config-reader.ts
const CACHE_TTL_MS = 5_000;
const STALE_GRACE_MS = 30_000;   // serve last-known-good this long on read error
const FORCE_STOP_KEY = 'engine-room:force-stop';

interface CacheEntry { config: EngineConfig; fetchedAt: number }
const cache = new Map<number, CacheEntry>();

export async function getEngineConfig(tenantId: number): Promise<EngineConfig> { /* … */ }
export function __resetConfigCacheForTests(): void { cache.clear(); }
```

Order of operations, and the order matters:

1. **`ENGINE_FORCE_STOP`.** If `process.env.ENGINE_FORCE_STOP?.trim().toLowerCase() === 'true'`, return `failClosedConfig(tenantId, source)` immediately. No DB read, no cache, no way to override from the UI. This is the operator's physical brake.
2. **Redis force-stop flag.** `await redis.get(FORCE_STOP_KEY)`; if set, return fail-closed and *do not* populate the cache. This is what makes emergency stop sub-30s (review focus #1) — the command worker sets it, and every dial gate sees it on its next job regardless of cache state.
3. **Cache.** If `Date.now() - fetchedAt < CACHE_TTL_MS`, return the cached config.
4. **Source selection** on `ENGINE_CONFIG_SOURCE`:
   - `env` (default while rolling out) — `configFromEnv()`, source `'env'`.
   - `shadow` — read both, return the **env** config, and log a structured `config_parity` record with `diffConfigs()` at `warn` when non-empty. 24h of zero mismatches is the gate to `db`.
   - `db` — read `engine_config WHERE tenant_id = $1 AND is_current` and `rowToConfig`.
   - anything else — fail closed with a critical log. An unrecognised source is a deploy error, not a default.
5. **Read error or zero rows or schema mismatch:**
   - If a cache entry exists and is younger than `STALE_GRACE_MS`, return it marked `degraded: true` and log at `warn`. (Review focus #2 — a Neon blip must not stop the engine.)
   - Otherwise return `failClosedConfig`, log `critical`, and raise an Alert Center exception — **deduped**: only insert when no open `exceptions` row of the same `type` exists for this tenant.

The exception insert reuses the `lib/exceptions/bridge.ts:64-70` shape:

```ts
await db.query(
  `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail,
     tenant_id, pipeline_load_id, source_module, suggested_action, sla_due_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + ($11 || ' minutes')::interval)`,
  [null, null, 'engine_config_unreadable', 'critical',
   'Engine config unreadable — engine failed closed',
   detail, tenantId, null, 'engine-room', 'Check DATABASE_URL and engine_config on the worker host', 15],
);
```

**Test** (`config-reader.test.ts`, DB-backed):
- With `ENGINE_CONFIG_SOURCE=db` and a seeded current row, returns that row's values and `source: 'db'`.
- Two calls inside 5s issue one query (spy on `db.query` call count); a call after the TTL issues a second.
- With `ENGINE_CONFIG_SOURCE=db` and the row deleted, returns `callingEnabled: false, pipelineEnabled: false, degraded: true` and inserts exactly **one** `exceptions` row across three consecutive calls.
- With `ENGINE_FORCE_STOP=true` and a fully-enabled current row, returns fail-closed and makes **zero** DB queries.
- With the Redis force-stop key set and a warm cache holding `callingEnabled: true`, returns fail-closed.
- With `ENGINE_CONFIG_SOURCE=nonsense`, fail-closed + no throw.
- Stale grace: seed a config, warm the cache, then point the reader at a failing query; within 30s it returns the cached values with `degraded: true`, and after the grace window it returns fail-closed.

---

## Task 6 — Redis force-stop primitive

A tiny module so the reader and the command worker share one key name and one TTL policy.

```ts
// lib/engine-room/force-stop.ts
const KEY = 'engine-room:force-stop';
/** Set by emergency_stop. No TTL — only an explicit resume clears it. */
export async function setForceStop(reason: string, by: string): Promise<void>;
export async function clearForceStop(): Promise<void>;
export async function isForceStopped(): Promise<boolean>;
```

Uses `lib/redis.ts` (REST) rather than the BullMQ ioredis connection, so a BullMQ connection problem cannot make the brake unreadable. **If Redis itself is unreachable, `isForceStopped()` returns `true`** — the brake fails on.

**Test:** `isForceStopped()` returns `true` when the client throws; round-trips set/clear; `setForceStop` stores the reason and actor for the UI to display.

---

## Task 7 — `writeEngineConfig()` with versioning and audit

```ts
// lib/engine-room/config-writer.ts
export interface ConfigWriteRequest {
  tenantId: number;
  changedBy: string;
  reason: string;
  source: 'ui' | 'brake' | 'emergency_stop' | 'seed';
  patch: Partial<Omit<EngineConfig, 'tenantId' | 'version' | 'source' | 'degraded'>>;
  /** required when the patch raises maxConcurrentCalls; must equal 'CONFIRM' */
  typedConfirmation?: string;
}
export type ConfigWriteResult =
  | { ok: true; version: number; diff: Record<string, [unknown, unknown]> }
  | { ok: false; status: number; errors: string[] };
```

Validation, all server-side, before any write:
- `reason` trimmed length ≥ 3, else 400.
- Unknown patch keys ⇒ 400 (no silent drop).
- `callingHoursStart >= 8`, `callingHoursEnd <= 20`, `start < end` ⇒ 400.
- `maxCallsPerPhonePerDay >= 1` ⇒ 400.
- `maxConcurrentCalls` above the current value requires `typedConfirmation === 'CONFIRM'` ⇒ 428 otherwise. Lowering it never requires confirmation.
- `maxConcurrentCalls <= 50` and `rampCapCallsPerHour <= RAMP_CEILING` (500) ⇒ 400 otherwise.
- `source: 'ui'` writes require an `admin`-equivalent caller; the writer takes `changedBy` and an already-resolved `role`, and refuses `viewer`. (Route-level enforcement is Phase 2, but the writer refuses regardless — defence in depth, and it means Phase 2's route cannot forget.)

Mechanics, in one transaction:

```sql
WITH cur AS (
  SELECT * FROM engine_config WHERE tenant_id = $1 AND is_current FOR UPDATE
), bumped AS (
  UPDATE engine_config SET is_current = false
   WHERE tenant_id = $1 AND is_current RETURNING version
)
INSERT INTO engine_config (tenant_id, version, is_current, …)
SELECT $1, COALESCE((SELECT version FROM cur), 0) + 1, true, …
RETURNING *;
```

The `(tenant_id, version)` unique constraint is the real guard: a concurrent writer that read the same version loses with a constraint violation, which the writer surfaces as `409`, not as a lost update (review focus #3). Then insert the `engine_config_audit` row with the computed `diff` in the **same** transaction — an audit row that can be missing is not an audit.

**Test** (`config-writer.test.ts`):
- First write for a tenant with no rows produces `version: 1`.
- Second write produces `version: 2`, exactly one `is_current` row, and an audit row whose `diff` names only the changed fields.
- Raising `maxConcurrentCalls` without `typedConfirmation` → `{ ok: false, status: 428 }` and **no rows written**.
- Raising it with `typedConfirmation: 'confirm'` (lowercase) → still 428. Typed means typed.
- Lowering it with no confirmation → succeeds.
- `callingHoursStart: 6` → 400.
- `maxCallsPerPhonePerDay: 0` → 400.
- `reason: ''` → 400, nothing written.
- `role: 'viewer'` → 403, nothing written.
- Two writers racing the same version: one succeeds, the other returns 409, and the table has exactly two versions (not two rows at the same version).
- Audit row count equals config row count for the tenant after a 5-write sequence.
- As `myra_app`, `UPDATE engine_config_audit SET reason = 'x'` raises `permission denied`, and so does `DELETE`. Append-only has to be a grant, not a convention — `neondb_owner` can still do both, which is why the production apply and the Railway role rotation belong in the same sitting.

---

## Task 8 — `scripts/seed-engine-config.ts`

Idempotent. Resolves the tenant with `getMyraTenantId()`, and if no `is_current` row exists, writes version 1 via `writeEngineConfig` with `source: 'seed'` and `reason: 'E2-05 Phase 1 initial seed'`. Values come from **the current Railway env, passed explicitly on argv or read from `process.env`**, not guessed — and the script prints the resolved values and requires `--confirm` to write. Defaults if a flag is absent: everything off, `max_concurrent_calls: 0`.

This is the one task that benefits from the Railway values the operator offered to fetch, and it is the *only* one — the seed can also run with explicit flags, so nothing is blocked:

```bash
pnpm tsx --env-file=.env.local scripts/seed-engine-config.ts \
  --pipeline-enabled=true --max-concurrent-calls=0 --scanner-enabled=false --confirm
```

**Test:** running it twice produces exactly one config row; a second run with different values is a no-op and says so.

---

## Task 9 — `lib/workers/command-worker.ts`

Not a BullMQ worker — a poller, because the producer is Vercel writing a row, not an enqueue. 2s interval.

Command vocabulary for Phase 1, in `lib/engine-room/commands.ts`. **Only commands that can be executed truthfully today:**

| command | effect | truthful? |
|---|---|---|
| `emergency_stop` | `setForceStop()` + `writeEngineConfig({calling_enabled:false, pipeline_enabled:false}, source:'emergency_stop')` + pause all BullMQ queues | yes |
| `resume` | `clearForceStop()` + resume queues. Does **not** re-enable flags — those are a separate deliberate config write | yes |
| `pause_queue` / `resume_queue` | `queue.pause()` / `queue.resume()` on a named queue | yes — `base-worker.ts:309` already has `pause()`, previously uncalled |
| `end_call` | `POST https://api.retellai.com/v2/stop-call/{call_id}` | yes — Retell supports it (204) |
| `retry_job` | re-enqueue a failed `agent_jobs` row onto its queue | yes |
| `drain_queue` | `queue.drain()` | yes |
| `schedule_callback` | enqueue `CallbackQueuePayload` onto `callback-queue` | yes **once Task 11 lands**; until then this command must return `failed` with `'no consumer'` |
| `listen_call` | — | **no.** Retell's monitor WS is text/events only; audio listen exists only in the dashboard. Not in the vocabulary. The UI's control gets hidden in Phase 2 and the Phase 2 report says why |

Claiming, exactly once (review focus #4):

```ts
const claimed = await db.query(
  `UPDATE engine_commands
      SET status = 'running', claimed_at = NOW(), claimed_by = $1
    WHERE id = (
      SELECT id FROM engine_commands
       WHERE status = 'pending' AND requested_at > NOW() - INTERVAL '10 minutes'
       ORDER BY requested_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    )
    RETURNING *`,
  [hostId],
);
if (claimed.rowCount === 0) return;
```

`FOR UPDATE SKIP LOCKED` plus the status predicate means two command workers never execute the same row. Commands older than 10 minutes are swept to `expired` by the same loop — a stale emergency stop must not fire an hour late.

Every command writes `status`, `completed_at`, and either `result` or `error_message`. The UI's `runCommand()` polls `commandStatus` for up to 30s, so a command that cannot finish in 30s must still mark itself terminal.

**Test** (`command-worker.test.ts`):
- `emergency_stop` row → after one tick, Redis force-stop set, a new config version with `callingEnabled: false`, an audit row with `source: 'emergency_stop'`, and the command `succeeded`.
- Two worker instances ticking concurrently on one pending row: exactly one `claimed_by`, one `succeeded`, and the side effect applied once.
- A `pending` row requested 11 minutes ago → `expired`, not executed.
- An unknown `command_type` → `failed` with a message, and no side effects.
- `end_call` with a stubbed Retell 204 → `succeeded`; with a 404 → `failed` carrying the status.
- Duplicate `idempotency_key` insert → unique violation at the DB, so the UI's retry cannot double-stop.

---

## Task 10 — `worker_heartbeats` writer

Replace the log-only interval at `scripts/run-workers.ts:167`.

```ts
// lib/engine-room/heartbeat.ts
export const STALE_AFTER_MS = 30_000;
export async function upsertHeartbeat(entry: {
  workerName: string; hostId: string; queueName?: string;
  configVersion?: number; configSource?: string; detail?: Record<string, unknown>;
}): Promise<void>;
export async function listWorkerHealth(): Promise<Array<{ workerName: string; lastSeenAt: Date; stale: boolean; … }>>;
```

Interval 10s (`WORKER_HEARTBEAT_MS` default changes `60000 → 10000`). `ON CONFLICT (worker_name) DO UPDATE SET last_seen_at = NOW(), …`. `started_at` is only set on insert, so the UI can show uptime. The heartbeat carries `config_version` and `config_source` — that is what lets the Engine Room prove a config change actually reached Railway, which is the whole point of rule 1.

A heartbeat write failure must **not** crash the host: catch, log at `warn`, continue. The absence of a heartbeat is itself the signal.

**Test:** upsert twice, assert one row, `last_seen_at` advanced, `started_at` unchanged; `listWorkerHealth()` marks a row backdated 31s as `stale: true` and one backdated 29s as `false`.

---

## Task 11 — `lib/workers/callback-worker.ts` (operator-mandated)

Consumes `callback-queue`, whose producer already exists in `retell-webhook.ts` and whose payload is `CallbackQueuePayload {pipelineLoadId, briefId, phoneNumber, callbackTime, timestamp}` (`lib/pipeline/retell-types.ts:339-347`). Extends `BaseWorker`:

```ts
const CONFIG: WorkerConfig = {
  queueName: 'callback-queue',
  expectedStage: 'callback',
  nextStage: undefined,        // the worker re-enqueues to call-queue; voice-worker owns the stage move
  concurrency: 5,
  retryConfig: { attempts: 2, backoff: { type: 'exponential', delay: 60_000 } },
  redis: redisConnection,
};
```

`process()` gate order, deliberately mirroring `voice-worker.ts` so there is one dial-safety story and not two:

1. `const config = await getEngineConfig(tenantId)`.
2. `if (!config.pipelineEnabled || !config.callbacksEnabled || !config.callingEnabled)` → log + return without re-enqueueing. **A disabled engine drops the callback rather than holding it**, and the drop is logged with the payload so it can be re-created from the UI. Holding it would mean a surprise call burst the moment calling is re-enabled.
3. **Re-validate the stage.** Re-read `pipeline_loads` and bail if the stage is not `callback` — by the time a delayed job fires the load may be `expired`, `declined` or `booked` (review focus #5).
4. **Re-run compliance.** DNC lookup (`SELECT id FROM dnc_list WHERE phone = $1 LIMIT 1`) and calling hours from `config.callingHoursStart/End`, not the hardcoded 8/20. A shipper who entered DNC between the webhook and the callback must not be called.
5. Attempt cap: count prior `agent_calls` for this load with `call_type = 'outbound_shipper'`; if ≥ `config.callbackMaxAttempts`, move the load to `escalated` and write an `exceptions` row rather than calling again.
6. Re-enqueue onto `call-queue` with the brief payload, letting `voice-worker` own every dial-side gate including `acquireCallSlot`.

This worker never calls Retell. That is what keeps "Railway is the authority" meaning one dial gate, not two.

**Test** (`callback-worker.test.ts`, DB-backed):
- Happy path: stage `callback`, config enabled, inside hours → one job added to `call-queue`.
- `callbacksEnabled: false` → zero jobs added, a log line, job completes (no retry storm).
- Load stage `expired` → zero jobs added.
- Phone in `dnc_list` → zero jobs added, and a `compliance_audit` row written.
- Outside calling hours per config (set `callingHoursEnd: 9` and run at 10:00 fixed clock) → zero jobs added.
- Attempt cap reached → load `escalated`, one `exceptions` row, zero jobs added.

`escalation-queue` stays consumer-less in Phase 1 and the Phase 1 report says so — escalations already resolve in the Alert Center via `exceptions`, which is rule 6 (reuse, don't duplicate). Adding a second consumer would duplicate it.

---

## Task 12 — Migrate the worker read sites

One commit per worker, each with its gate test, because every one of these is a live-call-path change needing human review (risk E3-R1).

**`voice-worker.ts`** — replace lines 96-106 and 173-178:

```ts
const config = await getEngineConfig(tenantId);
if (!config.pipelineEnabled) { /* existing shadow path */ }
if (!config.callingEnabled || config.maxConcurrentCalls <= 0) { /* existing shadow path */ }
// …
const slot = await acquireCallSlot(config.maxConcurrentCalls);
```

and in `recheckCompliance()`, `hour < config.callingHoursStart || hour >= config.callingHoursEnd`.

**`compiler-worker.ts:143`** — `const shadowMode = !config.callingEnabled || config.maxConcurrentCalls <= 0`. This resolves the `=== '0'` vs `<= 0` disagreement in favour of one predicate in one place.

**`carrier-voice-worker.ts`** and **`dispatcher-worker.ts`** — move the flag out of the constructor into `process()`. The constructor option stays for test injection, but when it is absent the flag is read per job, not per boot. **Without this change a config write cannot reach these two workers at all**, which would make their UI toggles fake buttons.

**`shipper-confirmation-worker.ts:139`** — same, per job.

**Test** (one per worker): construct the worker, seed a config with the flag off, run `process()` against a fixture load, assert no outbound side effect; flip the config row, clear the reader cache, run again, assert the side effect. That second half is the proof rule 1 demands — a config row change visibly changes worker behaviour.

---

## Task 13 — Emergency stop under 30 seconds

An end-to-end timing test, not a unit test.

1. Seed a config with `callingEnabled: true, maxConcurrentCalls: 5`.
2. Warm `getEngineConfig`'s cache in the test process.
3. Insert an `emergency_stop` command row and record `t0`.
4. Tick the command worker loop.
5. Poll `voice-worker`'s gate decision (call `process()` against a fixture) until it refuses, recording `t1`.
6. Assert `t1 - t0 < 30_000`, and in practice `< 3_000` because the Redis flag short-circuits the cache.
7. Assert a new config version, an audit row with `source: 'emergency_stop'`, and that `resume` restores the gate only after an explicit config write re-enables calling.

The test also asserts the inverse: with the Redis flag path removed (monkeypatched to always return false), the stop still lands within the 5s cache TTL plus one poll — so the bound holds even if Redis is down. Two independent paths, both inside the budget.

---

## Task 14 — Error-rate brake

A function called from the command-worker loop (it already ticks every 2s, so no new scheduler):

```ts
// lib/engine-room/brake.ts
export async function evaluateErrorRateBrake(tenantId: number): Promise<{ tripped: boolean; detail?: string }>;
```

Window and threshold come from config. Numerator and denominator come from `agent_calls` within the window: `failed`/`error` outcomes over total completed. Requires a minimum sample of 8 calls — a 1-of-2 failure is not a 50% error rate worth stopping an engine for. On trip:

1. `writeEngineConfig({ callingEnabled: false }, { source: 'brake', changedBy: 'system:brake', reason: … })`.
2. One `exceptions` row, severity `critical`, type `engine_error_rate_brake`, deduped against open rows.
3. Never auto-resumes. A human clears it from the Alert Center and writes a config change.

**Test:** 10 calls, 3 failed, threshold 25% → tripped, config version bumped, one exception. 2 calls, 1 failed → not tripped (below minimum sample). Already-disabled calling → no second write, no duplicate exception.

---

## Task 15 — `scripts/run-workers.ts` wiring

- Add `command-worker` and `callback-worker` to the boot list → 12 workers.
- Replace the log-only heartbeat with `upsertHeartbeat`, interval 10s, carrying the live config version/source.
- At boot, read the config once and **log every resolved value plus `source` and `degraded`**, replacing the kill-switch log at `:119-129`. Remove the retired `AUTO_BOOK_PROFIT_THRESHOLD` line.
- If the boot read is `degraded`, log `critical` and continue — the workers will individually refuse to dial, which is the correct fail-closed behaviour, and crashing the host would also stop the command worker that could fix it.
- Fix the stale `queues.ts:4` header comment ("9 queues" → 12).

**Test:** an integration test that boots the host with `ENGINE_FORCE_STOP=true`, asserts a heartbeat row appears within 15s and that `config_source` is recorded.

---

## Task 16 — Engine 3 isolation guard

```ts
// __tests__/engine-room/engine3-isolation.test.ts
it('no worker imports evaluateAuthority', async () => {
  const files = await glob('lib/workers/**/*.ts');
  for (const f of files) {
    expect(await readFile(f, 'utf8')).not.toMatch(/evaluateAuthority/);
  }
});
```

Rule 4 as an executable assertion rather than a promise. Also asserts no file under `lib/engine-room/` imports from `lib/governance/`.

---

## Task 17 — Phase 1 report

`docs/E2-05_phase1_report.md`:
- What each control actually does, with the test name that proves it.
- The one control removed from the vocabulary (`listen_call`) and why.
- The `escalation-queue` decision and why it is not a gap.
- Measured emergency-stop latency from Task 13, both paths.
- `ENGINE_CONFIG_SOURCE` rollout state: shipped at `env`, the 24h-zero-mismatch gate to `db`, and who flips it.
- Confirmation that migration 062 is applied to `dev-tests` only, and that production apply plus the Railway `DATABASE_URL` rotation to `myra_app` are separate operator steps.
- Explicitly: **nothing in this phase changes production behaviour until the migration is applied and `ENGINE_CONFIG_SOURCE` is set to `db` on Railway.** Until then the reader returns exactly what the env returns today.

---

## Out of scope for Phase 1

API routes (Phase 2), the UI (Phase 2), role resolution from `tenant_users` and the `cookies()`-based server session helper (Phase 2), Engine 3 shadow envelope versions and disagreement verdicts (Phase 3), batch *creation* from the UI (Phase 2 — Phase 1 only lands the table and the nullable columns), production apply of 062 (separate operator step), the Railway redeploy and billing (operator, and a hard blocker on observing any of this live).

## Known blocker, stated plainly

Railway has had no running deployment since 2026-06-06 because the trial expired. Everything in this phase is testable on `dev-tests` and provable by test, but **no part of it can be observed working in production until Railway billing is settled and `railway up` runs from a clean checkout.** That is the operator's step, not a build step, and it does not block Tasks 1–17.
