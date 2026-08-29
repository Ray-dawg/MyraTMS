# T-25 Risk & Fraud Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize Pilot 1's manual carrier/payer risk practices into scored, auditable tables and detection functions — payer credit, concentration-cap math, banking-change halt detection/recording — without automating any fraud/credit decision and without wiring the halt into the live dispatch path.

**Architecture:** New `payer_registry`/`payer_credit_assessments`/`transaction_halts`/`carrier_banking_details` tables (all read/write via `lib/risk/*.ts`, pure-core-where-possible), a payer reconciliation script mirroring T-20's carrier one, and a minimal, additive widening of T-24's `SourceSignal` type so this module's halt/payer-risk detections can route through the *existing* `bridgeToExceptions()` without touching its already-shipped pollers.

**Tech Stack:** PostgreSQL (Neon), TypeScript, Next.js API routes, `db.query<T>()` via `@/lib/pipeline/db-adapter`, `withTenant()` for Category A tables, Vitest.

**Spec:** `Engine 3/T25_Risk_Fraud.md`

## Global Constraints

- **No automated fraud/credit decision, ever** (criterion/§2 out-of-scope, E3-00's L3 placement) — this module scores and flags; a human decides.
- **Zero changes to `dispatcher-worker.ts` or any other live-path file** (criterion 7). The halt is detected and recorded, not enforced — T-25b's job, not this one.
- **Zero modification to `lib/exceptions/bridge.ts`'s existing pollers or their classification-rules seed rows** (criterion 6, spec's exact wording about not touching existing `lifecycle_late`/`carrier_risk`/`stage_escalated`/`dead_letter` handling). The only change to that file is widening the `SourceSignal.sourceModule` union type to accept two new literals — a non-breaking addition, not a behavior change to any existing poller.
- **Schema-reality correction #1:** spec §4.3's view has a literal broken SQL comment where a join condition should be (`pr.id = /* resolved via shipper->payer_registry link */`) and assumes a `pipeline_loads.tenant_id` column that doesn't exist (same bug class already fixed in T-23's `v_lifecycle_late_loads`). Fixed here by adding a real `pipeline_loads.payer_registry_id` column (mirroring T-20's `carriers.carrier_registry_id` pattern) plus a reconciliation script, and by selecting `fn_myra_tenant_id()::integer AS tenant_id` instead of the nonexistent column.
- **Schema-reality correction #2:** no banking-detail storage exists anywhere in this codebase — `carriers` has zero bank/routing/account columns. §4.5's `getCarrierBankingOnFile()` assumes a source that must be built. The new `carrier_banking_details` table stores only the last 4 digits of any account number, never a full number — a deliberate security choice, not a spec requirement, since this module has no reason to hold more than the minimum needed to detect a *change*.
- **Schema-reality correction #3:** `carrier_risk_signals` (T-20) has zero rows in production — no detector has ever populated it. Acceptance criterion 1 explicitly allows seeded signals; this plan's tests seed them rather than waiting for real ones.
- **Schema-reality correction #4:** `pipeline_loads.load_source_class` (T-19/E2-01's shadow gate) is 100% NULL across all 256 real rows. The double-broker cross-check will correctly report zero matches — an honest zero reflecting shadow-only enforcement, not evidence the report works.
- **`tenant_policies` gets one new nullable column** (`concentration_cap_pct NUMERIC(5,2)`), same pattern as `margin_floor_pct` — read with an app-level default (25) when NULL, never a DB-level default.
- **A documented, deliberate limitation:** a `carrier_risk` exception bridged by T-24's existing `pollCarrierRisk()` does not yet carry the source signal's own computed severity tier (it's always classified at the flat 'medium' T-24 already shipped) — reconciling that is out of scope this pass per Global Constraint #3 above, not silently glossed over. `computeCarrierRiskSeverity()` is used for the new `GET /api/risk/carrier/:id` endpoint and a backfill script, not for changing bridge routing.
- **Migration numbering:** next free number is `055` (highest existing is `054-t24-exception-classification-rules.sql`).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/055-t25-risk-fraud-scoring.sql` | 4 new tables, 2 additive columns, corrected view, 2 new classification-rule seed rows |
| `scripts/t25_reconcile_payer_registry.ts` | Normalized-name matching, backfills `pipeline_loads.payer_registry_id` |
| `lib/risk/payer-credit.ts` | `getPayerCreditStatus()`, `getConcentrationCap()` |
| `lib/risk/carrier-risk-scoring.ts` | `computeCarrierRiskSeverity()` (pure) |
| `lib/risk/banking-change-detection.ts` | `checkBankingChange()` — detection + recording + bridge call |
| `lib/risk/double-broker-crosscheck.ts` | `runDoubleBrokerCrossCheck()` |
| `lib/exceptions/bridge.ts` | Modified — one-line type widening only |
| `app/api/risk/carrier/[carrierRegistryId]/route.ts` | `GET` |
| `app/api/risk/payer/[payerRegistryId]/assess/route.ts` | `POST` |
| `app/api/risk/payer/[payerRegistryId]/concentration/route.ts` | `GET` |
| `app/api/risk/halts/route.ts` | `GET ?status=active` |
| `app/api/risk/halts/[id]/resume/route.ts` | `POST` |
| `app/api/risk/double-broker-crosscheck/route.ts` | `GET` |

---

### Task 1: Migration — tables, columns, corrected view, classifier seed rows

**Files:**
- Create: `scripts/055-t25-risk-fraud-scoring.sql`
- Test: `__tests__/risk/t25-schema.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- 055 — T-25 RISK & FRAUD SCORING
-- ============================================================================
-- Engine 3 Phase 2, Module 6. See Engine 3/T25_Risk_Fraud.md.
--
-- Schema-reality corrections (see the implementation plan's Global
-- Constraints for full reasoning, not repeated here):
--   1. Spec §4.3's view has a literal broken join placeholder and assumes a
--      pipeline_loads.tenant_id column that doesn't exist. Fixed: a real
--      pipeline_loads.payer_registry_id column (mirroring T-20's
--      carriers.carrier_registry_id) + fn_myra_tenant_id() in the view.
--   2. No banking-detail storage exists anywhere in this codebase.
--      carrier_banking_details is new, storing only account-number last4.
--   3. tenant_policies.concentration_cap_pct is additive/nullable, same
--      pattern as margin_floor_pct — app code defaults it to 25, not the DB.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id') THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'carrier_registry') THEN
        RAISE EXCEPTION 'carrier_registry not found — migration 044 (T-20) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'exception_classification_rules') THEN
        RAISE EXCEPTION 'exception_classification_rules not found — migration 054 (T-24) must be applied first';
    END IF;
END $$;

-- ============================================================
-- 1. payer_registry — platform-level, mirrors carrier_registry
-- ============================================================
CREATE TABLE IF NOT EXISTS payer_registry (
    id                        SERIAL PRIMARY KEY,
    legal_name                VARCHAR(200) NOT NULL,
    known_aliases             TEXT[],
    tax_id_or_business_number VARCHAR(30),

    first_seen_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at          TIMESTAMP,
    created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payer_registry_name ON payer_registry(LOWER(legal_name));

-- ============================================================
-- 2. payer_credit_assessments
-- ============================================================
CREATE TABLE IF NOT EXISTS payer_credit_assessments (
    id                SERIAL PRIMARY KEY,
    payer_registry_id INTEGER NOT NULL REFERENCES payer_registry(id) ON DELETE CASCADE,

    credit_level      VARCHAR(20) NOT NULL,   -- 'unknown' | 'weak' | 'acceptable' | 'strong'
    assessment_source VARCHAR(30) NOT NULL,   -- 'manual' | 'factor_declination_signal' | 'external_bureau'
    assessment_notes  TEXT,

    assessed_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assessed_by       VARCHAR(100) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payer_credit_current ON payer_credit_assessments(payer_registry_id, assessed_at DESC);

-- ============================================================
-- 3. transaction_halts
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_halts (
    id               SERIAL PRIMARY KEY,
    pipeline_load_id INTEGER NOT NULL REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    halt_reason      VARCHAR(40) NOT NULL,
    -- 'banking_change_detected' | 'insurance_lapsed' | 'critical_carrier_risk' |
    -- 'concentration_cap_breach' | 'unknown_payer_credit'
    halt_detail      JSONB DEFAULT '{}',

    halted_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    halted_by        VARCHAR(20) NOT NULL DEFAULT 'system_auto',

    resumed_at       TIMESTAMP,
    resumed_by       VARCHAR(100),
    resolution_note  TEXT
);

CREATE INDEX IF NOT EXISTS idx_halts_active ON transaction_halts(pipeline_load_id) WHERE resumed_at IS NULL;

-- ============================================================
-- 4. carrier_banking_details — new (not in base spec, see finding #2)
-- ============================================================
CREATE TABLE IF NOT EXISTS carrier_banking_details (
    carrier_registry_id   INTEGER PRIMARY KEY REFERENCES carrier_registry(id) ON DELETE CASCADE,
    bank_name             VARCHAR(200),
    routing_number        VARCHAR(20),
    account_number_last4  VARCHAR(4),
    account_holder_name   VARCHAR(200),
    recorded_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 5. Additive linkage columns
-- ============================================================
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS payer_registry_id INTEGER REFERENCES payer_registry(id);
ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS concentration_cap_pct NUMERIC(5,2);

-- ============================================================
-- 6. v_payer_concentration_exposure — corrected per finding #1
-- ============================================================
CREATE OR REPLACE VIEW v_payer_concentration_exposure AS
SELECT fn_myra_tenant_id()::integer AS tenant_id,
       pr.id AS payer_registry_id, pr.legal_name,
       SUM(pl.agreed_rate) AS open_exposure,
       SUM(pl.agreed_rate) / NULLIF(
           (SELECT SUM(agreed_rate) FROM pipeline_loads
            WHERE stage IN ('booked','dispatched','delivered') AND agreed_rate IS NOT NULL), 0
       ) AS concentration_pct
FROM pipeline_loads pl
JOIN payer_registry pr ON pr.id = pl.payer_registry_id
WHERE pl.stage IN ('booked', 'dispatched', 'delivered') AND pl.agreed_rate IS NOT NULL
GROUP BY pr.id, pr.legal_name;

-- ============================================================
-- 7. Classifier extension — additive rows only, existing 5 rows untouched
-- ============================================================
INSERT INTO exception_classification_rules (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version) VALUES
(2, 'payer_risk', '{}'::jsonb, 'high', 1440,
  'Review payer credit before extending further exposure.', 1),
(2, 'transaction_halt', '{}'::jsonb, 'critical', 15,
  'Immediate human review required — transaction halted automatically.', 1)
ON CONFLICT (tenant_id, source_module, version) DO NOTHING;
```

- [ ] **Step 2: Apply on a disposable Neon branch**

Create branch `t25-verify` from production (`mcp__Neon__create_branch`). Apply via `mcp__Neon__run_sql`, one statement per call.

- [ ] **Step 3: Write the failing test**

```typescript
// __tests__/risk/t25-schema.test.ts
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('T-25 schema (055)', () => {
  it('creates all 4 new tables and the 2 additive columns', async () => {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('payer_registry','payer_credit_assessments','transaction_halts','carrier_banking_details')`,
    );
    expect(tables.rows.length).toBe(4);

    const cols = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'pipeline_loads' AND column_name = 'payer_registry_id')
           OR (table_name = 'tenant_policies' AND column_name = 'concentration_cap_pct')`,
    );
    expect(cols.rows.length).toBe(2);
  });

  it('seeds the 2 new classification-rule rows without touching the existing 5', async () => {
    const { rows } = await db.query<{ source_module: string }>(
      `SELECT source_module FROM exception_classification_rules WHERE tenant_id = 2 ORDER BY source_module, version`,
    );
    expect(rows.length).toBe(7);
    expect(rows.map((r) => r.source_module)).toContain('payer_risk');
    expect(rows.map((r) => r.source_module)).toContain('transaction_halt');
  });
});
```

- [ ] **Step 4: Run against `t24-verify`... wait — run against `t25-verify`, verify FAIL then PASS**

Run: `pnpm vitest run __tests__/risk/t25-schema.test.ts` — expect FAIL before Step 2's branch has the migration, PASS after (with `DATABASE_URL` pointed at `t25-verify`).

- [ ] **Step 5: Commit**

```bash
git add scripts/055-t25-risk-fraud-scoring.sql __tests__/risk/t25-schema.test.ts
git commit -m "T-25: payer_registry/payer_credit_assessments/transaction_halts/carrier_banking_details + corrected concentration view + classifier extension seed rows"
```

---

### Task 2: Payer reconciliation script

**Files:**
- Create: `scripts/t25_reconcile_payer_registry.ts`
- Test: `__tests__/risk/t25-reconcile-payer.test.ts`

**Interfaces:**
- Produces: `reconcilePayerRegistry(): Promise<{total: number; matched: number; created: number}>` — populates `pipeline_loads.payer_registry_id` for every row with a non-null `shipper_company`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/risk/t25-reconcile-payer.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { reconcilePayerRegistry } from '../../scripts/t25_reconcile_payer_registry';

const REF = `T25PAYER-${Date.now()}`;

describe('reconcilePayerRegistry', () => {
  let pl1: number;
  let pl2: number;

  beforeAll(async () => {
    const a = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type,
         stage, shipper_company)
       VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'booked', $2) RETURNING id`,
      [`${REF}-A`, `  Acme Co  `],
    );
    pl1 = a.rows[0].id;
    const b = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type,
         stage, shipper_company)
       VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'booked', $2) RETURNING id`,
      [`${REF}-B`, 'ACME CO'], // same payer, different casing/whitespace
    );
    pl2 = b.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id IN ($1, $2)`, [pl1, pl2]);
    await db.query(`DELETE FROM payer_registry WHERE legal_name = 'Acme Co'`);
  });

  it('creates one payer_registry row and links both loads to it (case/whitespace-insensitive match)', async () => {
    const result = await reconcilePayerRegistry();
    expect(result.total).toBeGreaterThanOrEqual(2);

    const rows = await db.query<{ payer_registry_id: number }>(
      `SELECT payer_registry_id FROM pipeline_loads WHERE id IN ($1, $2)`,
      [pl1, pl2],
    );
    expect(rows.rows[0].payer_registry_id).not.toBeNull();
    expect(rows.rows[0].payer_registry_id).toBe(rows.rows[1].payer_registry_id);

    const payerCount = await db.query(`SELECT COUNT(*) FROM payer_registry WHERE legal_name = 'Acme Co'`);
    expect(payerCount.rows[0].count).toBe('1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/risk/t25-reconcile-payer.test.ts` — FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// scripts/t25_reconcile_payer_registry.ts
//
// T-25 §4.1/§4.3 — resolves the spec's broken payer_registry join by
// populating pipeline_loads.payer_registry_id. No MC-number equivalent
// exists for payers, so matching is by normalized (trimmed, lowercased)
// shipper_company text against payer_registry.legal_name — confirmed
// workable against real data (256 pipeline_loads rows, only 15 distinct
// normalized company names). Idempotent: only processes rows where
// payer_registry_id IS NULL.

import { db } from '../lib/pipeline/db-adapter';

interface PipelineLoadRow {
  id: number;
  shipper_company: string;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export async function reconcilePayerRegistry(): Promise<{ total: number; matched: number; created: number }> {
  const { rows } = await db.query<PipelineLoadRow>(
    `SELECT id, shipper_company FROM pipeline_loads
      WHERE shipper_company IS NOT NULL AND payer_registry_id IS NULL`,
  );

  let matched = 0;
  let created = 0;
  const cache = new Map<string, number>();

  for (const row of rows) {
    const key = normalize(row.shipper_company);
    let payerId = cache.get(key);

    if (payerId === undefined) {
      const existing = await db.query<{ id: number }>(
        `SELECT id FROM payer_registry WHERE LOWER(TRIM(legal_name)) = $1 LIMIT 1`,
        [key],
      );
      if (existing.rows.length > 0) {
        payerId = existing.rows[0].id;
        matched++;
      } else {
        const inserted = await db.query<{ id: number }>(
          `INSERT INTO payer_registry (legal_name) VALUES ($1) RETURNING id`,
          [row.shipper_company.trim()],
        );
        payerId = inserted.rows[0].id;
        created++;
      }
      cache.set(key, payerId);
    } else {
      matched++;
    }

    await db.query(`UPDATE pipeline_loads SET payer_registry_id = $1 WHERE id = $2`, [payerId, row.id]);
  }

  return { total: rows.length, matched, created };
}

async function main(): Promise<void> {
  const result = await reconcilePayerRegistry();
  console.log(`Reconciled ${result.total} pipeline_loads rows: ${result.matched} matched an existing payer, ${result.created} created a new payer_registry row.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[t25-reconcile-payer] failed:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/risk/t25-reconcile-payer.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/t25_reconcile_payer_registry.ts __tests__/risk/t25-reconcile-payer.test.ts
git commit -m "T-25: payer_registry reconciliation script (normalized-name matching)"
```

---

### Task 3: Payer credit status + concentration cap

**Files:**
- Create: `lib/risk/payer-credit.ts`
- Test: `lib/risk/__tests__/payer-credit.test.ts`

**Interfaces:**
- Produces: `getPayerCreditStatus(payerRegistryId: number): Promise<{creditLevel: string; flagged: boolean; reason: string}>`, `getConcentrationCap(tenantId: number): Promise<number>` — consumed by Task 7's API routes.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/risk/__tests__/payer-credit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { getPayerCreditStatus, getConcentrationCap } from '@/lib/risk/payer-credit';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('getPayerCreditStatus', () => {
  it('treats a payer with no assessment on file as unknown and flagged (acceptance criterion 2)', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    const status = await getPayerCreditStatus(1);
    expect(status).toEqual({ creditLevel: 'unknown', flagged: true, reason: 'No credit assessment on file.' });
  });

  it('flags a weak-credit payer', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ credit_level: 'weak' }] });
    const status = await getPayerCreditStatus(2);
    expect(status.flagged).toBe(true);
    expect(status.creditLevel).toBe('weak');
  });

  it('does not flag a strong-credit payer', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ credit_level: 'strong' }] });
    const status = await getPayerCreditStatus(3);
    expect(status.flagged).toBe(false);
  });
});

describe('getConcentrationCap', () => {
  it('defaults to 25 when tenant_policies.concentration_cap_pct is NULL', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ concentration_cap_pct: null }] });
    expect(await getConcentrationCap(2)).toBe(25);
  });

  it('uses the tenant override when set', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ concentration_cap_pct: '15.00' }] });
    expect(await getConcentrationCap(2)).toBe(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/risk/__tests__/payer-credit.test.ts` — FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/risk/payer-credit.ts
//
// T-25 §4.2/criterion 2 — a payer with no row here is 'unknown' by
// definition; per Pilot 1's own rule, unknown credit is flagged regardless
// of margin, not treated as neutral.

import { db } from '@/lib/pipeline/db-adapter';

export interface PayerCreditStatus {
  creditLevel: string;
  flagged: boolean;
  reason: string;
}

export async function getPayerCreditStatus(payerRegistryId: number): Promise<PayerCreditStatus> {
  const { rows } = await db.query<{ credit_level: string }>(
    `SELECT credit_level FROM payer_credit_assessments
      WHERE payer_registry_id = $1 ORDER BY assessed_at DESC LIMIT 1`,
    [payerRegistryId],
  );

  if (rows.length === 0) {
    return { creditLevel: 'unknown', flagged: true, reason: 'No credit assessment on file.' };
  }

  const creditLevel = rows[0].credit_level;
  const flagged = creditLevel === 'unknown' || creditLevel === 'weak';
  return { creditLevel, flagged, reason: flagged ? `Credit level is '${creditLevel}'.` : `Credit level is '${creditLevel}' — no flag.` };
}

const DEFAULT_CONCENTRATION_CAP_PCT = 25;

export async function getConcentrationCap(tenantId: number): Promise<number> {
  const { rows } = await db.query<{ concentration_cap_pct: string | null }>(
    `SELECT concentration_cap_pct FROM tenant_policies
      WHERE tenant_id = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  const raw = rows[0]?.concentration_cap_pct;
  return raw != null ? Number(raw) : DEFAULT_CONCENTRATION_CAP_PCT;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/risk/__tests__/payer-credit.test.ts` — PASS, all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/risk/payer-credit.ts lib/risk/__tests__/payer-credit.test.ts
git commit -m "T-25: payer credit status (unknown/weak flagged, strong not) + tenant concentration cap"
```

---

### Task 4: Concentration math validation (acceptance criterion 3)

**Files:**
- Test: `__tests__/risk/t25-concentration-math.test.ts`

100% arithmetic accuracy required per spec — this task validates the view directly against hand-calculated cases, no application code to write.

- [ ] **Step 1: Write and run the test**

```typescript
// __tests__/risk/t25-concentration-math.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const REF = `T25CONC-${Date.now()}`;

describe('v_payer_concentration_exposure — 100% arithmetic accuracy (criterion 3)', () => {
  let payerAId: number;
  let payerBId: number;
  const loadIds: number[] = [];

  beforeAll(async () => {
    const a = await db.query<{ id: number }>(`INSERT INTO payer_registry (legal_name) VALUES ($1) RETURNING id`, [`${REF}-PayerA`]);
    payerAId = a.rows[0].id;
    const b = await db.query<{ id: number }>(`INSERT INTO payer_registry (legal_name) VALUES ($1) RETURNING id`, [`${REF}-PayerB`]);
    payerBId = b.rows[0].id;

    // Hand-calculated: total open exposure = 1000 (A) + 3000 (A) + 6000 (B) = 10000.
    // A = 4000/10000 = 40%. B = 6000/10000 = 60%.
    const rates: [number, number][] = [[payerAId, 1000], [payerAId, 3000], [payerBId, 6000]];
    for (const [payerId, rate] of rates) {
      const ins = await db.query<{ id: number }>(
        `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
           destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type,
           stage, agreed_rate, payer_registry_id)
         VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'booked', $2, $3) RETURNING id`,
        [`${REF}-${loadIds.length}`, rate, payerId],
      );
      loadIds.push(ins.rows[0].id);
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [loadIds]);
    await db.query(`DELETE FROM payer_registry WHERE id IN ($1, $2)`, [payerAId, payerBId]);
  });

  it('computes exact percentages for both payers against total real open exposure', async () => {
    const { rows } = await db.query<{ payer_registry_id: number; open_exposure: string; concentration_pct: string }>(
      `SELECT payer_registry_id, open_exposure, concentration_pct FROM v_payer_concentration_exposure
        WHERE payer_registry_id IN ($1, $2)`,
      [payerAId, payerBId],
    );
    const a = rows.find((r) => r.payer_registry_id === payerAId)!;
    const b = rows.find((r) => r.payer_registry_id === payerBId)!;
    expect(Number(a.open_exposure)).toBe(4000);
    expect(Number(b.open_exposure)).toBe(6000);

    // Percentages are against the GLOBAL total (all open loads in the DB,
    // not just this test's fixtures), so assert the ratio between the two
    // test payers rather than an absolute percentage — this is exact
    // arithmetic either way (a/b = 4000/6000 = 0.6666...).
    const ratio = Number(a.concentration_pct) / Number(b.concentration_pct);
    expect(ratio).toBeCloseTo(4000 / 6000, 10);
  });
});
```

Run: `pnpm vitest run __tests__/risk/t25-concentration-math.test.ts` (against `t25-verify`) — expect PASS.

- [ ] **Step 2: Commit**

```bash
git add __tests__/risk/t25-concentration-math.test.ts
git commit -m "T-25: concentration-math validation against hand-calculated cases (acceptance criterion 3)"
```

---

### Task 5: Carrier risk severity scoring + banking-change detection

**Files:**
- Create: `lib/risk/carrier-risk-scoring.ts`
- Create: `lib/risk/banking-change-detection.ts`
- Test: `lib/risk/__tests__/carrier-risk-scoring.test.ts`
- Test: `lib/risk/__tests__/banking-change-detection.test.ts`

**Interfaces:**
- Consumes: `bridgeToExceptions()` from `@/lib/exceptions/bridge` (Task 6 widens its type first — see note below).
- Produces: `computeCarrierRiskSeverity(signalType: string): 'low'|'medium'|'high'|'critical'`; `checkBankingChange(carrierRegistryId: number, incoming: BankingDetails): Promise<{halted: boolean; loadsHalted: number[]}>`.

*(Sequencing note: this task's banking-change test imports `bridgeToExceptions`, whose type Task 6 widens. Do Task 6 first if running strictly in order; both are independent enough that order doesn't affect correctness, only import resolution during isolated test runs.)*

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/risk/__tests__/carrier-risk-scoring.test.ts
import { describe, it, expect } from 'vitest';
import { computeCarrierRiskSeverity } from '@/lib/risk/carrier-risk-scoring';

describe('computeCarrierRiskSeverity', () => {
  it('scores banking_change_mid_transaction as critical', () => {
    expect(computeCarrierRiskSeverity('banking_change_mid_transaction')).toBe('critical');
  });
  it('scores insurance_lapsed and authority_reassigned as high', () => {
    expect(computeCarrierRiskSeverity('insurance_lapsed')).toBe('high');
    expect(computeCarrierRiskSeverity('authority_reassigned')).toBe('high');
  });
  it('scores excessive_cancellation_rate and name_mismatch as medium', () => {
    expect(computeCarrierRiskSeverity('excessive_cancellation_rate')).toBe('medium');
    expect(computeCarrierRiskSeverity('name_mismatch')).toBe('medium');
  });
  it('falls back to medium for an unrecognized signal type rather than throwing', () => {
    expect(computeCarrierRiskSeverity('some_future_signal_type')).toBe('medium');
  });
});
```

```typescript
// lib/risk/__tests__/banking-change-detection.test.ts
import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';
import { checkBankingChange } from '@/lib/risk/banking-change-detection';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));
vi.mock('@/lib/exceptions/bridge', () => ({ bridgeToExceptions: vi.fn(async () => true) }));

describe('checkBankingChange', () => {
  it('halts every active load when banking details differ from what is on file', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ bank_name: 'Bank A', routing_number: '111', account_number_last4: '1234' }] }) // on file
      .mockResolvedValueOnce({ rows: [{ id: 501 }, { id: 502 }] }) // active pipeline loads
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // insert halt load 501
      .mockResolvedValueOnce({ rows: [{ id: 2 }] }); // insert halt load 502

    const result = await checkBankingChange(7, { bankName: 'Bank B', routingNumber: '222', accountNumberLast4: '5678' });
    expect(result.halted).toBe(true);
    expect(result.loadsHalted).toEqual([501, 502]);
    expect(bridgeToExceptions).toHaveBeenCalledTimes(2);
  });

  it('does not halt when incoming details match what is on file', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ bank_name: 'Bank A', routing_number: '111', account_number_last4: '1234' }] })
      .mockResolvedValueOnce({ rows: [{ id: 501 }] });

    const result = await checkBankingChange(7, { bankName: 'Bank A', routingNumber: '111', accountNumberLast4: '1234' });
    expect(result.halted).toBe(false);
    expect(bridgeToExceptions).not.toHaveBeenCalled();
  });

  it('does not halt when there is no active load, even if banking details differ', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ bank_name: 'Bank A', routing_number: '111', account_number_last4: '1234' }] })
      .mockResolvedValueOnce({ rows: [] }); // no active loads

    const result = await checkBankingChange(7, { bankName: 'Bank B', routingNumber: '222', accountNumberLast4: '5678' });
    expect(result.halted).toBe(false);
    expect(bridgeToExceptions).not.toHaveBeenCalled();
  });

  it('does not halt when there is nothing on file yet (first time recording banking details)', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] }); // nothing on file
    const result = await checkBankingChange(7, { bankName: 'Bank A', routingNumber: '111', accountNumberLast4: '1234' });
    expect(result.halted).toBe(false);
    expect(bridgeToExceptions).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/risk/__tests__/carrier-risk-scoring.test.ts lib/risk/__tests__/banking-change-detection.test.ts` — FAIL, modules not found.

- [ ] **Step 3: Write the implementations**

```typescript
// lib/risk/carrier-risk-scoring.ts
//
// T-25 §2 — "adds severity computation" for T-20's carrier_risk_signals
// signal types (migration 044's comment lists the 6 named types). Pure
// function, used by the GET /api/risk/carrier/:id endpoint and a future
// backfill — deliberately NOT wired into lib/exceptions/bridge.ts's
// existing pollCarrierRisk(), which stays untouched per Global Constraints.

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_BY_SIGNAL_TYPE: Record<string, RiskSeverity> = {
  banking_change_mid_transaction: 'critical',
  insurance_lapsed: 'high',
  authority_reassigned: 'high',
  multiple_mc_same_contact: 'high',
  excessive_cancellation_rate: 'medium',
  name_mismatch: 'medium',
};

export function computeCarrierRiskSeverity(signalType: string): RiskSeverity {
  return SEVERITY_BY_SIGNAL_TYPE[signalType] ?? 'medium';
}
```

```typescript
// lib/risk/banking-change-detection.ts
//
// T-25 §4.5 — detection + recording only, per this module's explicit scope:
// zero wiring into dispatcher-worker.ts. Reuses T-24's exported
// bridgeToExceptions() rather than re-implementing dedup/classification —
// this is the module's entire integration surface with T-24, no changes to
// T-24's own pollers.

import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

export interface BankingDetails {
  bankName: string;
  routingNumber: string;
  accountNumberLast4: string;
}

function bankingDetailsMatch(a: BankingDetails, b: BankingDetails): boolean {
  return a.bankName === b.bankName && a.routingNumber === b.routingNumber && a.accountNumberLast4 === b.accountNumberLast4;
}

export async function checkBankingChange(
  carrierRegistryId: number,
  incoming: BankingDetails,
): Promise<{ halted: boolean; loadsHalted: number[] }> {
  const onFileRes = await db.query<{ bank_name: string; routing_number: string; account_number_last4: string }>(
    `SELECT bank_name, routing_number, account_number_last4 FROM carrier_banking_details WHERE carrier_registry_id = $1`,
    [carrierRegistryId],
  );
  if (onFileRes.rows.length === 0) {
    return { halted: false, loadsHalted: [] }; // nothing on file yet — first recording, not a change
  }

  const onFile: BankingDetails = {
    bankName: onFileRes.rows[0].bank_name,
    routingNumber: onFileRes.rows[0].routing_number,
    accountNumberLast4: onFileRes.rows[0].account_number_last4,
  };
  if (bankingDetailsMatch(onFile, incoming)) {
    return { halted: false, loadsHalted: [] };
  }

  const activeRes = await db.query<{ id: number }>(
    `SELECT pl.id FROM pipeline_loads pl
       JOIN loads l ON l.pipeline_load_id = pl.id
       JOIN carriers c ON c.id = l.carrier_id
      WHERE c.carrier_registry_id = $1 AND l.status NOT IN ('Delivered', 'Invoiced', 'Closed')`,
    [carrierRegistryId],
  );
  if (activeRes.rows.length === 0) {
    return { halted: false, loadsHalted: [] };
  }

  const tenantId = await getMyraTenantId();
  const loadsHalted: number[] = [];
  for (const row of activeRes.rows) {
    try {
      await db.query(
        `INSERT INTO transaction_halts (pipeline_load_id, halt_reason, halt_detail, halted_by)
         VALUES ($1, 'banking_change_detected', $2, 'system_auto')`,
        [row.id, JSON.stringify({ onFile, incoming })],
      );
      await bridgeToExceptions({
        tenantId,
        sourceModule: 'transaction_halt',
        exceptionType: 'banking_change_detected',
        title: `Banking change detected — carrier_registry_id=${carrierRegistryId}, pipeline load ${row.id}`,
        description: 'Incoming carrier banking details differ from what is on file while this load is active. Transaction halted pending human review.',
        context: {},
        pipelineLoadId: row.id,
        loadId: null,
        carrierId: null,
      });
      loadsHalted.push(row.id);
    } catch (err) {
      logger.error('[risk/banking-change-detection] failed to record halt', err);
    }
  }
  return { halted: loadsHalted.length > 0, loadsHalted };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/risk/__tests__/carrier-risk-scoring.test.ts lib/risk/__tests__/banking-change-detection.test.ts` — PASS, all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/risk/carrier-risk-scoring.ts lib/risk/banking-change-detection.ts lib/risk/__tests__/carrier-risk-scoring.test.ts lib/risk/__tests__/banking-change-detection.test.ts
git commit -m "T-25: carrier-risk severity scoring + banking-change halt detection/recording (criterion 4)"
```

---

### Task 6: Widen T-24's `SourceSignal` type (the only change to `bridge.ts`)

**Files:**
- Modify: `lib/exceptions/bridge.ts`
- Test: `lib/exceptions/__tests__/bridge.test.ts` (existing T-24 file — add cases, don't replace)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SourceSignal.sourceModule` now accepts `'payer_risk' | 'transaction_halt'` in addition to T-24's original 5 values — consumed by Task 5 (already written against this) and Task 7's payer-risk API logic.

- [ ] **Step 1: Add 2 failing cases to the existing bridge test**

Append to `lib/exceptions/__tests__/bridge.test.ts` (inside the existing `describe('bridgeToExceptions', ...)` block):

```typescript
  it('accepts sourceModule=transaction_halt (T-25 extension) and routes it through the same insert path', async () => {
    (matchClassificationRule as any).mockResolvedValueOnce({ severity: 'critical', slaMinutes: 15, suggestedAction: 'Review now.' });
    const queryMock = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'exc-2' }] });
    (withTenant as any).mockImplementationOnce((_id: number, cb: any) => cb({ query: queryMock }));

    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'transaction_halt', exceptionType: 'banking_change_detected',
      title: 'Halt', description: 'desc', context: {}, pipelineLoadId: 501, loadId: null, carrierId: null,
    });
    expect(result).toBe(true);
  });

  it('accepts sourceModule=payer_risk (T-25 extension)', async () => {
    (matchClassificationRule as any).mockResolvedValueOnce(null); // no rule configured for this test tenant
    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'payer_risk', exceptionType: 'payer_credit_flagged',
      title: 'Payer risk', description: 'desc', context: {}, pipelineLoadId: null, loadId: null, carrierId: null,
    });
    expect(result).toBe(false); // exercises the type accepting the value; behavior already covered by the "no rule matches" case above
  });
```

- [ ] **Step 2: Run to verify the type doesn't yet accept these values**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep bridge.test`
Expected: a type error on `sourceModule: 'transaction_halt'` / `'payer_risk'` — not assignable to `SourceSignal['sourceModule']`.

- [ ] **Step 3: Widen the type — the only edit to this file**

In `lib/exceptions/bridge.ts`, change:

```typescript
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter';
```

to:

```typescript
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter'
    | 'payer_risk' | 'transaction_halt'; // T-25 extension — no other line in this file changes
```

- [ ] **Step 4: Run the full bridge test file + typecheck**

Run: `pnpm vitest run lib/exceptions/__tests__/bridge.test.ts && pnpm tsc --noEmit -p tsconfig.json`
Expected: all 5 cases (3 original + 2 new) pass; typecheck clean.

- [ ] **Step 5: Re-run T-24's classification-rules schema test to confirm zero disturbance**

Run: `pnpm vitest run __tests__/exceptions/t24-classification-rules-schema.test.ts __tests__/exceptions/t24-existing-rules-regression.test.ts`
Expected: still PASS — this task touched no query, no poller, no seed row.

- [ ] **Step 6: Commit**

```bash
git add lib/exceptions/bridge.ts lib/exceptions/__tests__/bridge.test.ts
git commit -m "T-25: widen SourceSignal.sourceModule to accept payer_risk/transaction_halt (only change to bridge.ts — criterion 6)"
```

---

### Task 7: Double-broker cross-check + all 6 API routes

**Files:**
- Create: `lib/risk/double-broker-crosscheck.ts`
- Create: `app/api/risk/carrier/[carrierRegistryId]/route.ts`
- Create: `app/api/risk/payer/[payerRegistryId]/assess/route.ts`
- Create: `app/api/risk/payer/[payerRegistryId]/concentration/route.ts`
- Create: `app/api/risk/halts/route.ts`
- Create: `app/api/risk/halts/[id]/resume/route.ts`
- Create: `app/api/risk/double-broker-crosscheck/route.ts`
- Test: `__tests__/risk/t25-api.test.ts`

**Interfaces:**
- Consumes: `getPayerCreditStatus`/`getConcentrationCap` (Task 3), `computeCarrierRiskSeverity` (Task 5), `authorizeGovernanceRequest`/`resolveTenantId` (`@/lib/governance/api-helpers`, existing).
- Produces: `runDoubleBrokerCrossCheck(sinceDays: number): Promise<{checked: number; flagged: {pipelineLoadId: number; loadId: string}[]}>`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/risk/t25-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false, userId: 'u1', firstName: 'Test', lastName: 'User' } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getCarrierRisk } from '@/app/api/risk/carrier/[carrierRegistryId]/route';
import { POST as postAssess } from '@/app/api/risk/payer/[payerRegistryId]/assess/route';
import { GET as getConcentration } from '@/app/api/risk/payer/[payerRegistryId]/concentration/route';
import { GET as getHalts } from '@/app/api/risk/halts/route';
import { POST as postResume } from '@/app/api/risk/halts/[id]/resume/route';
import { GET as getCrossCheck } from '@/app/api/risk/double-broker-crosscheck/route';

describe('T-25 risk API', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET carrier risk returns signals with computed severity', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, signal_type: 'insurance_lapsed', severity: 'medium', detected_at: '2026-08-01' }] });
    const req = new NextRequest('http://x/api/risk/carrier/9');
    const res = await getCarrierRisk(req, { params: Promise.resolve({ carrierRegistryId: '9' }) });
    const body = await res.json();
    expect(body.signals[0].computedSeverity).toBe('high');
  });

  it('POST payer assess requires assessedBy and creditLevel', async () => {
    const req = new NextRequest('http://x/api/risk/payer/1/assess', { method: 'POST', body: JSON.stringify({}) });
    const res = await postAssess(req, { params: Promise.resolve({ payerRegistryId: '1' }) });
    expect(res.status).toBe(400);
  });

  it('POST payer assess inserts a new assessment row on valid input', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 55 }] });
    const req = new NextRequest('http://x/api/risk/payer/1/assess', {
      method: 'POST',
      body: JSON.stringify({ creditLevel: 'weak', assessmentSource: 'manual', assessmentNotes: 'slow to pay' }),
    });
    const res = await postAssess(req, { params: Promise.resolve({ payerRegistryId: '1' }) });
    expect(res.status).toBe(200);
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO payer_credit_assessments');
  });

  it('GET concentration returns the view row for the payer', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ payer_registry_id: 1, concentration_pct: '0.4' }] });
    const req = new NextRequest('http://x/api/risk/payer/1/concentration');
    const res = await getConcentration(req, { params: Promise.resolve({ payerRegistryId: '1' }) });
    const body = await res.json();
    expect(body.concentrationPct).toBe(0.4);
  });

  it('GET halts filters to active by default', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, halt_reason: 'banking_change_detected' }] });
    const req = new NextRequest('http://x/api/risk/halts');
    const res = await getHalts(req);
    const body = await res.json();
    expect(body.halts.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('resumed_at IS NULL');
  });

  it('POST resume requires actor and resolutionNote', async () => {
    const req = new NextRequest('http://x/api/risk/halts/1/resume', { method: 'POST', body: JSON.stringify({}) });
    const res = await postResume(req, { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(400);
  });

  it('GET double-broker-crosscheck returns the report shape', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const req = new NextRequest('http://x/api/risk/double-broker-crosscheck?since=90');
    const res = await getCrossCheck(req);
    const body = await res.json();
    expect(body.flagged).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/risk/t25-api.test.ts` — FAIL, modules not found.

- [ ] **Step 3: Write `lib/risk/double-broker-crosscheck.ts`**

```typescript
// lib/risk/double-broker-crosscheck.ts
//
// T-25 §2/criterion 5 — defense-in-depth: did any load T-19's
// evaluatePolicy() would reject under Myra's shipper_direct_or_coBroker
// policy (load_source_class='broker_posted', meaning no active co-broker
// agreement was found) actually get booked anyway. Read-only report.
// pipeline_loads.load_source_class is 100% NULL in production today (the
// shadow gate has never classified a real load) — this correctly reports
// zero matches right now, an honest reflection of shadow-only enforcement,
// not a validated true negative.

import { db } from '@/lib/pipeline/db-adapter';

export interface CrossCheckResult {
  checked: number;
  flagged: { pipelineLoadId: number; loadId: string }[];
}

export async function runDoubleBrokerCrossCheck(sinceDays: number): Promise<CrossCheckResult> {
  const { rows } = await db.query<{ id: number; load_id: string; load_source_class: string | null }>(
    `SELECT id, load_id, load_source_class FROM pipeline_loads
      WHERE stage IN ('booked', 'dispatched', 'delivered')
        AND created_at > NOW() - ($1 || ' days')::interval`,
    [sinceDays],
  );

  const flagged = rows
    .filter((r) => r.load_source_class === 'broker_posted')
    .map((r) => ({ pipelineLoadId: r.id, loadId: r.load_id }));

  return { checked: rows.length, flagged };
}
```

- [ ] **Step 4: Write the 6 API routes**

```typescript
// app/api/risk/carrier/[carrierRegistryId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { computeCarrierRiskSeverity } from '@/lib/risk/carrier-risk-scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ carrierRegistryId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { carrierRegistryId: raw } = await params;
  const carrierRegistryId = Number(raw);
  if (!Number.isInteger(carrierRegistryId)) {
    return NextResponse.json({ error: 'Invalid carrierRegistryId' }, { status: 400 });
  }

  try {
    const { rows } = await db.query<{ id: number; signal_type: string; severity: string; detected_at: string }>(
      `SELECT id, signal_type, severity, detected_at FROM carrier_risk_signals
        WHERE carrier_registry_id = $1 ORDER BY detected_at DESC`,
      [carrierRegistryId],
    );
    const signals = rows.map((r) => ({ ...r, computedSeverity: computeCarrierRiskSeverity(r.signal_type) }));
    return NextResponse.json({ carrierRegistryId, signals });
  } catch (err) {
    logger.error('[risk/carrier GET] failed', err);
    return NextResponse.json({ error: 'Failed to load carrier risk signals' }, { status: 500 });
  }
}
```

```typescript
// app/api/risk/payer/[payerRegistryId]/assess/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_LEVELS = ['unknown', 'weak', 'acceptable', 'strong'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ payerRegistryId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { payerRegistryId: raw } = await params;
  const payerRegistryId = Number(raw);
  if (!Number.isInteger(payerRegistryId)) {
    return NextResponse.json({ error: 'Invalid payerRegistryId' }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { creditLevel, assessmentSource, assessmentNotes } = body ?? {};
  if (!VALID_LEVELS.includes(creditLevel) || !assessmentSource) {
    return NextResponse.json({ error: 'creditLevel (unknown|weak|acceptable|strong) and assessmentSource are required' }, { status: 400 });
  }

  const assessedBy = `${auth.user.firstName ?? ''} ${auth.user.lastName ?? ''}`.trim() || auth.user.userId;

  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO payer_credit_assessments (payer_registry_id, credit_level, assessment_source, assessment_notes, assessed_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [payerRegistryId, creditLevel, assessmentSource, assessmentNotes ?? null, assessedBy],
    );
    return NextResponse.json({ id: rows[0].id, payerRegistryId, creditLevel, assessedBy });
  } catch (err) {
    logger.error('[risk/payer/assess POST] failed', err);
    return NextResponse.json({ error: 'Failed to record credit assessment' }, { status: 500 });
  }
}
```

```typescript
// app/api/risk/payer/[payerRegistryId]/concentration/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { getConcentrationCap } from '@/lib/risk/payer-credit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ payerRegistryId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { payerRegistryId: raw } = await params;
  const payerRegistryId = Number(raw);
  if (!Number.isInteger(payerRegistryId)) {
    return NextResponse.json({ error: 'Invalid payerRegistryId' }, { status: 400 });
  }
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query<{ payer_registry_id: number; open_exposure: string; concentration_pct: string }>(
      `SELECT payer_registry_id, open_exposure, concentration_pct FROM v_payer_concentration_exposure
        WHERE payer_registry_id = $1 AND tenant_id = $2`,
      [payerRegistryId, tenantId],
    );
    const cap = await getConcentrationCap(tenantId);
    const row = rows[0];
    return NextResponse.json({
      payerRegistryId,
      openExposure: row ? Number(row.open_exposure) : 0,
      concentrationPct: row ? Number(row.concentration_pct) : 0,
      capPct: cap,
      overCap: row ? Number(row.concentration_pct) * 100 > cap : false,
    });
  } catch (err) {
    logger.error('[risk/payer/concentration GET] failed', err);
    return NextResponse.json({ error: 'Failed to load concentration exposure' }, { status: 500 });
  }
}
```

```typescript
// app/api/risk/halts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const status = req.nextUrl.searchParams.get('status') ?? 'active';
  const whereClause = status === 'active' ? 'WHERE resumed_at IS NULL' : '';

  try {
    const { rows } = await db.query(
      `SELECT id, pipeline_load_id, halt_reason, halt_detail, halted_at, halted_by, resumed_at, resumed_by, resolution_note
         FROM transaction_halts ${whereClause} ORDER BY halted_at DESC`,
    );
    return NextResponse.json({ halts: rows });
  } catch (err) {
    logger.error('[risk/halts GET] failed', err);
    return NextResponse.json({ error: 'Failed to load transaction halts' }, { status: 500 });
  }
}
```

```typescript
// app/api/risk/halts/[id]/resume/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { actor, resolutionNote } = body ?? {};
  if (!actor || !resolutionNote) {
    return NextResponse.json({ error: 'actor and resolutionNote are required — resume is human-only' }, { status: 400 });
  }

  try {
    const { rows } = await db.query(
      `UPDATE transaction_halts SET resumed_at = NOW(), resumed_by = $1, resolution_note = $2
        WHERE id = $3 AND resumed_at IS NULL RETURNING *`,
      [actor, resolutionNote, id],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Halt not found or already resumed' }, { status: 404 });
    }
    return NextResponse.json(rows[0]);
  } catch (err) {
    logger.error('[risk/halts/resume POST] failed', err);
    return NextResponse.json({ error: 'Failed to resume halt' }, { status: 500 });
  }
}
```

```typescript
// app/api/risk/double-broker-crosscheck/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { runDoubleBrokerCrossCheck } from '@/lib/risk/double-broker-crosscheck';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const sinceDays = Number(req.nextUrl.searchParams.get('since') ?? '90');

  try {
    const result = await runDoubleBrokerCrossCheck(sinceDays);
    return NextResponse.json(result);
  } catch (err) {
    logger.error('[risk/double-broker-crosscheck GET] failed', err);
    return NextResponse.json({ error: 'Failed to run cross-check' }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run __tests__/risk/t25-api.test.ts` — PASS, all 7 cases.

- [ ] **Step 6: Commit**

```bash
git add lib/risk/double-broker-crosscheck.ts app/api/risk __tests__/risk/t25-api.test.ts
git commit -m "T-25: double-broker cross-check + 6 risk API endpoints"
```

---

### Task 8: Production apply + completion tracker

**Files:**
- Modify: `Engine 3/docs/superpowers/plans/completion.md`

- [ ] **Step 1: Confirm with the user before touching production** — same checkpoint as every prior module.
- [ ] **Step 2: Apply migration 055 to production**, verify all 4 tables + 2 columns + corrected view + 2 seed rows via direct query.
- [ ] **Step 3: Run `t25_reconcile_payer_registry.ts` against production**, report the real counts.
- [ ] **Step 4: Re-run this plan's own tests directly against production** (small, self-cleaning) for a second confirmation — not the full unrelated project suite, same deliberate scope limit as T-23/T-24.
- [ ] **Step 5: Run `runDoubleBrokerCrossCheck(90)` against production** and report the real number honestly (expected: 0 checked or 0 flagged, given `load_source_class` is 100% NULL — report whichever is true, don't round up).
- [ ] **Step 6: Add a T-25 section to the completion tracker** following T-20 through T-24's structure: spec link, status, schema-reality corrections (the 4 in Global Constraints), task checklist with dates, honest acceptance-criteria table (7 from spec §6), and the exact carrier_risk-severity limitation called out plainly.
- [ ] **Step 7: Commit**

```bash
git add "Engine 3/docs/superpowers/plans/completion.md"
git commit -m "T-25: completion tracker entry"
```

---

## Self-Review Notes

- **Spec coverage:** §4.1/4.2/4.4 (payer_registry, payer_credit_assessments, transaction_halts) — Task 1. §4.3 (concentration view) — Task 1 (corrected) + Task 4 (validated). §4.5 (banking-change detection) — Task 5. §2's double-broker cross-check — Task 7. §2's classifier extension — Task 6 (type only) + Task 5/7 (the actual calls). §5 (6 interfaces) — Task 7. §6 (7 acceptance criteria) — Tasks 1-7 individually, Task 8 confirms end-to-end. §7 (gate) — Task 8. §8 (portability) — no host-specific code introduced.
- **Explicitly out of scope per spec §2/§10, not built here:** wiring the halt into `dispatcher-worker.ts`; any automated fraud/credit decision; third-party credit bureau or NSC/FMCSA API integration.
- **New table not in the base spec, flagged plainly:** `carrier_banking_details` — required because no banking-detail storage exists anywhere in this codebase; spec §4.5 assumed a data source that had to be built first.
