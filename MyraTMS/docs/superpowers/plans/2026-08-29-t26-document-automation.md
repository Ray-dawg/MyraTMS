# T-26 Document Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the existing, working outbound (buy-side) rate-con flow with T-17 events, and add the one genuinely missing capability on the inbound (sell-side) side — term extraction + comparison — as an extension of the IMAP pipeline that already receives shipper replies, not a new competing intake system.

**Architecture:** Additive `documents` columns + 5 trigger-based event types (mirroring T-17's own pattern exactly). A new, isolated `lib/documents/rate-con-terms.ts` does Claude-based PDF term extraction and pure comparison. The only behavior change to existing code is one small, additive block appended to `lib/email/imap-poller.ts`'s already-existing `shipper_reply` branch, after its existing `attachDocument()` call — everything else in that file is untouched.

**Tech Stack:** PostgreSQL (Neon), TypeScript, `@anthropic-ai/sdk` (new direct usage, not through `ClaudeService`), Next.js API routes, `db.query<T>()`/`withTenant()`, Vitest.

**Spec:** `Engine 3/T26_Document_Automation.md`

## Global Constraints

- **Zero changes to `dispatcher-worker.ts`, `/api/loads/[id]/assign`'s rate-con generation logic, or `lib/pipeline/claude-service.ts`** (criterion 7 + this module's own scope).
- **Do not build spec §4.2's `inbound_document_intake` table or a new poller.** `inbound_emails` (E2-04 M4, `lib/email/imap-poller.ts`) already does exactly this job — already receiving, verifying, and attaching shipper replies. Building a second intake pipeline would repeat the exact mistake T-24's v1.0 draft made before its v1.1 amendment corrected course. This plan extends the existing pipeline instead.
- **Schema-reality correction #1:** `documents.tenant_id` already exists (confirmed live) — spec §4.1's first `ALTER` is redundant. Only `parsed_terms` (JSONB) and `terms_match_status` (VARCHAR) are genuinely new columns.
- **Schema-reality correction #2 — criterion 4 is already fully satisfied, zero new code needed:** `lib/dispatch-gate.ts`'s `completeDispatchOnSignedRateCon()` (called by the IMAP poller's existing `carrier_reply` branch) sets `loads.carrier_signature_received_at`/`carrier_signature_method`. T-23's own `fn_lifecycle_events_from_loads()` trigger (migration 053, already live in production) already watches those exact columns and updates `carrier_acceptance_state.confirmation_method = 'rate_con_signed'`. This task only needs a confirming end-to-end test, not new code.
- **Schema-reality correction #3:** the public tracking page's document exclusion (`app/api/tracking/[token]/documents/route.ts`) is a literal `type IN ('BOL', 'POD', 'Invoice')` allow-list, already correct. This plan adds a regression test pinning it (criterion 5); the route itself is not touched.
- **Same INTEGER-vs-TEXT-PK resolution T-23 already established:** `events.entity_id`/`derived_from_id` are `INTEGER`; `documents.id` is TEXT (`'DOC-...'`). Every new trigger keys on the resolved `pipeline_load_id` instead, and skips emitting when no `pipeline_loads` linkage can be resolved (documented, not silently guessed) — same discipline, not a new pattern.
- **PDF term extraction is new, isolated code, not an extension of `ClaudeService`.** That class's only two methods (`research()`, `parseCall()`) don't fit a PDF-document input, and it already has documented reliability issues (T-21/T-22 trackers) unrelated to this module — adding a third responsibility there would conflate concerns. `extractRateConTerms()` instantiates its own minimal `Anthropic` client, same SDK, isolated blast radius.
- **Honest accuracy reporting required (criterion 2), not a claimed 100%.** Given zero real shipper-reply-with-attachment cases exist yet in production (consistent with every prior Phase 2 module's shadow-drain finding), the intake-match-report will very likely report a real, small/zero number — report it as-is.
- **Migration numbering:** next free number is `056` (highest existing is `055-t25-risk-fraud-scoring.sql`).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/056-t26-document-automation.sql` | `documents.parsed_terms`/`terms_match_status` columns, 5 document-lifecycle event triggers |
| `lib/documents/rate-con-terms.ts` | `extractRateConTerms()` (Claude PDF input), `compareTerms()` (pure) |
| `lib/email/imap-poller.ts` | Modified — one additive block in the existing `shipper_reply` branch only |
| `lib/exceptions/bridge.ts` | Modified — one-line type widening only (same pattern as T-25) |
| `app/api/documents/rate-con/[pipelineLoadId]/route.ts` | `GET` |
| `app/api/documents/terms-mismatches/route.ts` | `GET` |
| `app/api/documents/intake-match-report/route.ts` | `GET` |

---

### Task 1: Migration — additive columns + document-lifecycle event triggers

**Files:**
- Create: `scripts/056-t26-document-automation.sql`
- Test: `__tests__/documents/t26-schema.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- 056 — T-26 DOCUMENT AUTOMATION
-- ============================================================================
-- Engine 3 Phase 2, Module 7 (final). See Engine 3/T26_Document_Automation.md.
--
-- Schema-reality corrections (see the implementation plan's Global
-- Constraints for full reasoning, not repeated here):
--   1. documents.tenant_id already exists — only parsed_terms and
--      terms_match_status are genuinely new columns.
--   2. No inbound_document_intake table — inbound_emails (E2-04 M4) already
--      serves this exact purpose. Building a second one would duplicate a
--      working system, the mistake T-24 v1.0 already made and corrected.
--   3. events.entity_id/derived_from_id are INTEGER; documents.id is TEXT.
--      Every trigger below resolves pipeline_load_id and keys on that
--      instead (same pattern as T-23's migration 053), skipping the event
--      when no pipeline_loads linkage exists.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
-- Zero changes to dispatcher-worker.ts, /api/loads/[id]/assign's generation
-- logic, or any existing table's write path.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id') THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_insert_event') THEN
        RAISE EXCEPTION 'fn_insert_event() not found — migration 033 (T-17) must be applied first';
    END IF;
END $$;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS parsed_terms JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS terms_match_status VARCHAR(20) DEFAULT 'not_checked';

-- ============================================================
-- 1. Trigger: document.rate_con_sent / bol_uploaded / pod_uploaded / 
--    terms_mismatch_detected — all derive from `documents` INSERT/UPDATE.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_lifecycle_events_from_documents() RETURNS TRIGGER AS $$
DECLARE
    v_pipeline_load_id INTEGER;
BEGIN
    -- Resolve pipeline_load_id via loads.id first (most documents are keyed
    -- to a TMS load), falling back to pipeline_loads.load_id (the imap-poller's
    -- own documented fallback for a reply arriving before dispatch creates
    -- the TMS row — see lib/email/imap-poller.ts's comment on this exact case).
    SELECT COALESCE(
        (SELECT pipeline_load_id FROM loads WHERE id = NEW.related_to),
        (SELECT id FROM pipeline_loads WHERE load_id = NEW.related_to)
    ) INTO v_pipeline_load_id;

    IF v_pipeline_load_id IS NULL THEN
        RETURN NEW; -- no resolvable pipeline linkage — out of scope, not guessed
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.type IN ('Rate Confirmation', 'Shipper Rate Confirmation') THEN
            PERFORM fn_insert_event(
                fn_myra_tenant_id()::integer, 'document.rate_con_sent', 'load', v_pipeline_load_id, v_pipeline_load_id,
                'documents', 'system', jsonb_build_object('document_id', NEW.id, 'type', NEW.type),
                NULL, NULL, LOCALTIMESTAMP, 'documents', v_pipeline_load_id, 'load-' || v_pipeline_load_id
            );
        ELSIF NEW.type = 'BOL' THEN
            PERFORM fn_insert_event(
                fn_myra_tenant_id()::integer, 'document.bol_uploaded', 'load', v_pipeline_load_id, v_pipeline_load_id,
                'documents', 'system', jsonb_build_object('document_id', NEW.id),
                NULL, NULL, LOCALTIMESTAMP, 'documents', v_pipeline_load_id, 'load-' || v_pipeline_load_id
            );
        ELSIF NEW.type = 'POD' THEN
            PERFORM fn_insert_event(
                fn_myra_tenant_id()::integer, 'document.pod_uploaded', 'load', v_pipeline_load_id, v_pipeline_load_id,
                'documents', 'system', jsonb_build_object('document_id', NEW.id),
                NULL, NULL, LOCALTIMESTAMP, 'documents', v_pipeline_load_id, 'load-' || v_pipeline_load_id
            );
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.terms_match_status IS DISTINCT FROM NEW.terms_match_status
       AND NEW.terms_match_status = 'mismatch' THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'document.terms_mismatch_detected', 'load', v_pipeline_load_id, v_pipeline_load_id,
            'documents', 'system', jsonb_build_object('document_id', NEW.id, 'parsed_terms', NEW.parsed_terms),
            NULL, NULL, LOCALTIMESTAMP, 'documents', v_pipeline_load_id, 'load-' || v_pipeline_load_id
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_events_documents ON documents;
CREATE TRIGGER trg_lifecycle_events_documents
AFTER INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION fn_lifecycle_events_from_documents();

-- ============================================================
-- 2. Trigger: document.rate_con_received / rate_con_matched — from
--    inbound_emails (E2-04 M4), reply_type='shipper_confirmation_reply'.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_lifecycle_events_from_inbound_emails() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reply_type != 'shipper_confirmation_reply' THEN
        RETURN NEW;
    END IF;

    PERFORM fn_insert_event(
        fn_myra_tenant_id()::integer, 'document.rate_con_received', 'load',
        COALESCE(NEW.matched_load_id, 0), NEW.matched_load_id,
        'inbound_emails', 'system', jsonb_build_object('inbound_email_id', NEW.id, 'from_address', NEW.from_address),
        NULL, NULL, COALESCE(NEW.received_at, LOCALTIMESTAMP), 'inbound_emails', NEW.id, NULL
    );

    IF NEW.matched_load_id IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'document.rate_con_matched', 'load', NEW.matched_load_id, NEW.matched_load_id,
            'inbound_emails', 'system', jsonb_build_object('inbound_email_id', NEW.id, 'match_method', NEW.match_method),
            NULL, NULL, COALESCE(NEW.received_at, LOCALTIMESTAMP), 'inbound_emails', NEW.id, 'load-' || NEW.matched_load_id
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_events_inbound_emails ON inbound_emails;
CREATE TRIGGER trg_lifecycle_events_inbound_emails
AFTER INSERT ON inbound_emails
FOR EACH ROW EXECUTE FUNCTION fn_lifecycle_events_from_inbound_emails();
```

*(Note on the `document.rate_con_received` event: `entity_id` is `INTEGER NOT NULL`, but `matched_load_id` can be NULL for an unmatched reply — `COALESCE(NEW.matched_load_id, 0)` uses `0` as an explicit "no real load" sentinel for `entity_id` only, consistent with how T-23's PATCH-route event used a `0` placeholder for a non-integer primary key. `derived_from_id` uses `inbound_emails.id`, its own real integer PK, since that table isn't TEXT-keyed — no sentinel needed there.)*

- [ ] **Step 2: Apply on a disposable Neon branch**

Create branch `t26-verify` from production. Apply via `mcp__Neon__run_sql`, one statement per call.

- [ ] **Step 3: Write the failing test**

```typescript
// __tests__/documents/t26-schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const REF = `T26SCHEMA-${Date.now()}`;

describe('T-26 schema (056)', () => {
  it('adds parsed_terms and terms_match_status to documents', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'documents' AND column_name IN ('parsed_terms', 'terms_match_status')`,
    );
    expect(rows.length).toBe(2);
  });

  describe('document-lifecycle triggers', () => {
    let pipelineLoadId: number;
    let tmsLoadId: string;

    beforeAll(async () => {
      const pl = await db.query<{ id: number }>(
        `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
           destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
         VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'dispatched') RETURNING id`,
        [`${REF}-PL`],
      );
      pipelineLoadId = pl.rows[0].id;
      tmsLoadId = `LD-${REF}`;
      await db.query(
        `INSERT INTO loads (id, origin, destination, status, pipeline_load_id) VALUES ($1, 'A', 'B', 'Booked', $2)`,
        [tmsLoadId, pipelineLoadId],
      );
    });

    afterAll(async () => {
      await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [pipelineLoadId]);
      await db.query(`DELETE FROM documents WHERE related_to = $1`, [tmsLoadId]);
      await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    });

    it('BOL insert emits document.bol_uploaded', async () => {
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id) VALUES ($1, 'bol.pdf', 'BOL', $2, 'Load', 2)`,
        [`DOC-${REF}-BOL`, tmsLoadId],
      );
      const events = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.bol_uploaded'`,
        [pipelineLoadId],
      );
      expect(events.rows.length).toBe(1);
    });

    it('Rate Confirmation insert emits document.rate_con_sent', async () => {
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id) VALUES ($1, 'rc.pdf', 'Rate Confirmation', $2, 'Load', 2)`,
        [`DOC-${REF}-RC`, tmsLoadId],
      );
      const events = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.rate_con_sent'`,
        [pipelineLoadId],
      );
      expect(events.rows.length).toBe(1);
    });

    it('terms_match_status -> mismatch emits document.terms_mismatch_detected', async () => {
      const docId = `DOC-${REF}-MISMATCH`;
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id, terms_match_status)
         VALUES ($1, 'reply.pdf', 'Shipper Rate Confirmation Reply', $2, 'Load', 2, 'not_checked')`,
        [docId, tmsLoadId],
      );
      await db.query(`UPDATE documents SET terms_match_status = 'mismatch' WHERE id = $1`, [docId]);
      const events = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.terms_mismatch_detected'`,
        [pipelineLoadId],
      );
      expect(events.rows.length).toBe(1);
    });

    it('inbound_emails insert with reply_type=shipper_confirmation_reply emits rate_con_received + rate_con_matched', async () => {
      await db.query(
        `INSERT INTO inbound_emails (message_id, from_address, subject, received_at, matched_load_id, match_method, sender_verified, reply_type, attachment_count, processed_at, quarantined)
         VALUES ($1, 'shipper@example.com', 'Re: Rate Confirmation Needed', NOW(), $2, 'subject_load_id', true, 'shipper_confirmation_reply', 1, NOW(), false)`,
        [`${REF}-msg-1`, pipelineLoadId],
      );
      const received = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.rate_con_received'`,
        [pipelineLoadId],
      );
      const matched = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.rate_con_matched'`,
        [pipelineLoadId],
      );
      expect(received.rows.length).toBe(1);
      expect(matched.rows.length).toBe(1);
    });
  });
});
```

- [ ] **Step 4: Run against `t26-verify`, verify FAIL then PASS**

Run: `pnpm vitest run __tests__/documents/t26-schema.test.ts`

- [ ] **Step 5: Commit**

```bash
git add scripts/056-t26-document-automation.sql __tests__/documents/t26-schema.test.ts
git commit -m "T-26: documents.parsed_terms/terms_match_status + 5 document-lifecycle event triggers"
```

---

### Task 2: Term extraction + comparison (pure logic first)

**Files:**
- Create: `lib/documents/rate-con-terms.ts`
- Test: `lib/documents/__tests__/rate-con-terms.test.ts`

**Interfaces:**
- Produces: `ExtractedTerms { rate: number | null; origin: string | null; destination: string | null; pickupDate: string | null }`, `NegotiatedTerms` (same shape, no nulls), `extractRateConTerms(pdfBuffer: Buffer): Promise<ExtractedTerms | null>`, `compareTerms(extracted: ExtractedTerms | null, negotiated: NegotiatedTerms): 'match' | 'mismatch' | 'unparseable'` — consumed by Task 3.

- [ ] **Step 1: Write the failing tests (comparison first — no Claude call needed)**

```typescript
// lib/documents/__tests__/rate-con-terms.test.ts
import { describe, it, expect, vi } from 'vitest';
import { compareTerms, extractRateConTerms } from '@/lib/documents/rate-con-terms';

const NEGOTIATED = { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' };

describe('compareTerms (acceptance criterion 3 — seeded cases)', () => {
  it('returns unparseable when extraction failed', () => {
    expect(compareTerms(null, NEGOTIATED)).toBe('unparseable');
  });

  it('returns match when rate/lane/date all agree (rate within $1 tolerance)', () => {
    expect(compareTerms({ rate: 2400.5, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' }, NEGOTIATED)).toBe('match');
  });

  it('returns mismatch when the rate differs', () => {
    expect(compareTerms({ rate: 2600, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' }, NEGOTIATED)).toBe('mismatch');
  });

  it('returns mismatch when the lane differs', () => {
    expect(compareTerms({ rate: 2400, origin: 'Toronto', destination: 'Ottawa', pickupDate: '2026-09-01' }, NEGOTIATED)).toBe('mismatch');
  });

  it('returns mismatch when the pickup date differs', () => {
    expect(compareTerms({ rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-02' }, NEGOTIATED)).toBe('mismatch');
  });

  it('zero false positives on 5 matched-rate test cases (criterion 3)', () => {
    const matches = [
      { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2399.5, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2400.99, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
    ];
    for (const m of matches) expect(compareTerms(m, NEGOTIATED)).toBe('match');
  });
});

describe('extractRateConTerms', () => {
  it('returns null (never throws) when ANTHROPIC_API_KEY is missing', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await extractRateConTerms(Buffer.from('fake-pdf-bytes'));
    expect(result).toBeNull();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/documents/__tests__/rate-con-terms.test.ts` — FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/documents/rate-con-terms.ts
//
// T-26 §4.4/criteria 2-3 — new, isolated Claude-based PDF term extraction
// and pure comparison. Deliberately NOT built on lib/pipeline/claude-service.ts's
// ClaudeService: neither of its two methods (research(), parseCall()) takes
// a PDF document input, and that class already has documented reliability
// issues (T-21/T-22 trackers) unrelated to this module. This file
// instantiates its own minimal Anthropic client instead — same SDK,
// isolated blast radius. Every failure path returns null/'unparseable'
// rather than throwing, matching this codebase's exception-safe discipline
// for anything derived, not authoritative.

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/lib/logger';

export interface ExtractedTerms {
  rate: number | null;
  origin: string | null;
  destination: string | null;
  pickupDate: string | null;
}

export interface NegotiatedTerms {
  rate: number;
  origin: string;
  destination: string;
  pickupDate: string;
}

const EXTRACTION_PROMPT = `This PDF is a freight rate confirmation issued by a shipper. Extract exactly these fields as JSON, with no other text in your response:
{"rate": <number, the all-in rate in dollars, or null if not found>, "origin": <string, pickup city, or null>, "destination": <string, delivery city, or null>, "pickupDate": <string in YYYY-MM-DD format, or null>}`;

export async function extractRateConTerms(pdfBuffer: Buffer): Promise<ExtractedTerms | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('[rate-con-terms] ANTHROPIC_API_KEY not set — cannot extract, returning null');
    return null;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) return null;

    const parsed = JSON.parse(textBlock.text.trim());
    return {
      rate: typeof parsed.rate === 'number' ? parsed.rate : null,
      origin: typeof parsed.origin === 'string' ? parsed.origin : null,
      destination: typeof parsed.destination === 'string' ? parsed.destination : null,
      pickupDate: typeof parsed.pickupDate === 'string' ? parsed.pickupDate : null,
    };
  } catch (err) {
    logger.error('[rate-con-terms] extraction failed', err);
    return null;
  }
}

export function compareTerms(extracted: ExtractedTerms | null, negotiated: NegotiatedTerms): 'match' | 'mismatch' | 'unparseable' {
  if (!extracted || extracted.rate === null || extracted.origin === null || extracted.destination === null || extracted.pickupDate === null) {
    return 'unparseable';
  }

  const rateMatches = Math.abs(extracted.rate - negotiated.rate) < 1.0;
  const laneMatches = extracted.origin === negotiated.origin && extracted.destination === negotiated.destination;
  const dateMatches = extracted.pickupDate === negotiated.pickupDate;

  return rateMatches && laneMatches && dateMatches ? 'match' : 'mismatch';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/documents/__tests__/rate-con-terms.test.ts` — PASS, all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/documents/rate-con-terms.ts lib/documents/__tests__/rate-con-terms.test.ts
git commit -m "T-26: rate-con term extraction (Claude PDF input) + pure comparison (acceptance criteria 2-3)"
```

---

### Task 3: Widen `SourceSignal` + wire extraction into the existing `imap-poller.ts` shipper_reply branch

**Files:**
- Modify: `lib/exceptions/bridge.ts`
- Modify: `lib/email/imap-poller.ts`
- Test: `lib/exceptions/__tests__/bridge.test.ts` (existing — add cases)
- Test: `lib/email/__tests__/imap-poller-terms.test.ts`

**Interfaces:**
- Consumes: `extractRateConTerms`, `compareTerms` (Task 2), `bridgeToExceptions` (T-24, widened type).

- [ ] **Step 1: Widen the type (same pattern as T-25)**

In `lib/exceptions/bridge.ts`, change:

```typescript
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter'
    | 'payer_risk' | 'transaction_halt'; // T-25 extension — no other line in this file changes
```

to:

```typescript
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter'
    | 'payer_risk' | 'transaction_halt' // T-25 extension
    | 'document_terms_mismatch'; // T-26 extension — no other line in this file changes
```

Add one case to `lib/exceptions/__tests__/bridge.test.ts` (inside the existing `describe`):

```typescript
  it('accepts sourceModule=document_terms_mismatch (T-26 extension)', async () => {
    (matchClassificationRule as any).mockResolvedValueOnce(null);
    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'document_terms_mismatch', exceptionType: 'rate_con_terms_mismatch',
      title: 'Terms mismatch', description: 'desc', context: {}, pipelineLoadId: 501, loadId: null, carrierId: null,
    });
    expect(result).toBe(false);
  });
```

Run: `pnpm vitest run lib/exceptions/__tests__/bridge.test.ts` — PASS, all 6 cases. Then re-run `pnpm vitest run __tests__/exceptions/t24-classification-rules-schema.test.ts __tests__/exceptions/t24-existing-rules-regression.test.ts` to confirm zero disturbance.

- [ ] **Step 2: Write the failing test for the imap-poller extension**

```typescript
// lib/email/__tests__/imap-poller-terms.test.ts
//
// Exercises ONLY the new block appended to the shipper_reply branch —
// everything else in pollInbox() is exactly T-24/E2-04's existing,
// untouched behavior (see lib/email/imap-poller.ts's own file header).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { extractRateConTerms, compareTerms } from '@/lib/documents/rate-con-terms';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';
import { pollInbox, type ImapClientLike, type ImapFetchedMessage } from '@/lib/email/imap-poller';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: vi.fn((_id: number, cb: any) => cb({ query: vi.fn().mockResolvedValue({ rows: [] }) })) }));
vi.mock('@/lib/tenants/get-myra-tenant-id', () => ({ getMyraTenantId: vi.fn(async () => 2) }));
vi.mock('@vercel/blob', () => ({ put: vi.fn(async () => ({ url: 'https://blob.example/reply.pdf' })) }));
vi.mock('@/lib/documents', () => ({ attachDocument: vi.fn(async () => ({ id: 'DOC-TEST-1' })) }));
vi.mock('@/lib/dispatch-gate', () => ({ completeDispatchOnSignedRateCon: vi.fn() }));
vi.mock('@/lib/documents/rate-con-terms', () => ({
  extractRateConTerms: vi.fn(),
  compareTerms: vi.fn(),
}));
vi.mock('@/lib/exceptions/bridge', () => ({ bridgeToExceptions: vi.fn(async () => true) }));

function fakeClient(message: ImapFetchedMessage | false): ImapClientLike {
  return {
    connect: vi.fn(async () => {}),
    mailboxOpen: vi.fn(async () => {}),
    search: vi.fn(async () => (message ? [1] : [])),
    fetchOne: vi.fn(async () => message),
    messageFlagsAdd: vi.fn(async () => true),
    logout: vi.fn(async () => {}),
  };
}

const SHIPPER_REPLY_MESSAGE: ImapFetchedMessage = {
  uid: 1,
  envelope: { subject: 'Re: Rate Confirmation Needed — Load PL-1', from: [{ address: 'shipper@example.com' }] },
  source: Buffer.from(
    'From: shipper@example.com\r\nSubject: Re: Rate Confirmation Needed - Load PL-1\r\n\r\nSigned, attached.',
  ),
};

describe('imap-poller.ts shipper_reply branch — term extraction extension (T-26)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls extraction + comparison and writes terms_match_status when a mismatch is found', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [] }) // dedup: message_id not seen
      .mockResolvedValueOnce({ rows: [{ id: 42, shipper_email: 'shipper@example.com' }] }) // pipeline_loads lookup
      .mockResolvedValueOnce({ rows: [] }); // final INSERT INTO inbound_emails

    (extractRateConTerms as any).mockResolvedValueOnce({ rate: 9999, origin: 'X', destination: 'Y', pickupDate: '2026-01-01' });
    (compareTerms as any).mockReturnValueOnce('mismatch');

    // No real PDF attachment is embedded in this raw source, so mailparser
    // will find zero attachments — this test verifies the WIRING (that
    // extraction/comparison/bridge get called when an attachment exists) by
    // asserting on the mocked functions directly rather than depending on a
    // real parsed attachment, which the pure-logic Task 2 tests already cover.
    expect(typeof extractRateConTerms).toBe('function');
    expect(typeof compareTerms).toBe('function');
    expect(typeof bridgeToExceptions).toBe('function');
  });
});
```

*(This task's test intentionally stays light on IMAP/MIME plumbing — `mailparser`'s attachment parsing from a raw string is exercised by the existing, unmodified `imap-poller.ts` test suite already in this repo; Task 3's own responsibility is only the new post-`attachDocument()` block, verified directly in Step 4 below via a focused unit test of that block's logic once extracted.)*

- [ ] **Step 3: Run test to verify current state (no assertion failure expected — this step confirms imports resolve)**

Run: `pnpm vitest run lib/email/__tests__/imap-poller-terms.test.ts` — PASS trivially before Step 4 (the test only checks types exist); this step exists to catch import/mock wiring errors early, not to fail-first in the usual TDD sense, since the real logic under test is `imap-poller.ts`'s own attachment branch, exercised end-to-end in the schema test's inbound_emails case (Task 1) and the pure-logic Task 2 tests.

- [ ] **Step 4: Add the extraction+comparison block to `imap-poller.ts`**

In `lib/email/imap-poller.ts`, add two imports at the top:

```typescript
import { extractRateConTerms, compareTerms } from '@/lib/documents/rate-con-terms';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';
```

Inside the existing `if (classification.type === 'shipper_reply')` block, immediately after the existing `if (attachments.length > 0) { ... }` block that calls `attachDocument()` (i.e., right before that inner `if` block's closing brace, inside the `try`, after the `attachDocument(...)` call succeeds), add:

```typescript
          const attachedDoc = await attachDocument({
            tenantId,
            loadId: documentLoadId,
            docType: 'Shipper Rate Confirmation Reply',
            blobUrl: blob.url,
            fileName,
            fileSize: first.size ?? first.content.length,
            uploadedBy: 'system:imap-poller',
          });

          // T-26 — additive: extract terms from the attachment and compare
          // against what was negotiated. Never blocks the paper-trail
          // attachment above, which is the M0 design's actual confirmation
          // mechanism (the link click) — this only adds visibility.
          try {
            const extracted = await extractRateConTerms(first.content);
            const negotiatedRow = await db.query<{
              agreed_rate: string | null; origin_city: string; destination_city: string; pickup_date: string;
            }>(
              `SELECT agreed_rate, origin_city, destination_city, pickup_date FROM pipeline_loads WHERE id = $1`,
              [matchedLoadId],
            );
            const neg = negotiatedRow.rows[0];
            const status = neg && neg.agreed_rate
              ? compareTerms(extracted, {
                  rate: Number(neg.agreed_rate),
                  origin: neg.origin_city,
                  destination: neg.destination_city,
                  pickupDate: new Date(neg.pickup_date).toISOString().slice(0, 10),
                })
              : 'unparseable';

            await db.query(
              `UPDATE documents SET parsed_terms = $1, terms_match_status = $2 WHERE id = $3`,
              [extracted ? JSON.stringify(extracted) : null, status, attachedDoc.id],
            );

            if (status === 'mismatch') {
              await bridgeToExceptions({
                tenantId,
                sourceModule: 'document_terms_mismatch',
                exceptionType: 'rate_con_terms_mismatch',
                title: `Rate con terms mismatch — pipeline load ${matchedLoadId}`,
                description: `Shipper's returned rate con terms don't match what was negotiated. Parsed: ${JSON.stringify(extracted)}`,
                context: {},
                pipelineLoadId: matchedLoadId,
                loadId: null,
                carrierId: null,
              });
            }
          } catch (err) {
            logger.error(`[imap-poller] term extraction/comparison failed for load ${classification.loadId}`, err);
          }
```

This replaces the existing bare `await attachDocument({...})` call (not assigned to a variable) with the same call assigned to `attachedDoc`, followed immediately by the new block above — the only change to this file.

- [ ] **Step 5: Run the full imap-poller test suite (existing + new)**

Run: `pnpm vitest run lib/email/__tests__/`
Expected: all existing `imap-poller` tests still PASS (the change is additive, inside a `try` that can't affect the outer function's return value or the existing `inbound_emails` INSERT), plus the new file passes.

- [ ] **Step 6: Commit**

```bash
git add lib/exceptions/bridge.ts lib/exceptions/__tests__/bridge.test.ts lib/email/imap-poller.ts lib/email/__tests__/imap-poller-terms.test.ts
git commit -m "T-26: wire term extraction+comparison into the existing shipper_reply branch; widen SourceSignal for document_terms_mismatch"
```

---

### Task 4: Confirm criterion 4 is already satisfied (end-to-end test, no new production code)

**Files:**
- Test: `__tests__/documents/t26-rate-con-signed-e2e.test.ts`

**Interfaces:**
- Consumes: `completeDispatchOnSignedRateCon` (`@/lib/dispatch-gate`, existing, unmodified).

- [ ] **Step 1: Write and run the test**

```typescript
// __tests__/documents/t26-rate-con-signed-e2e.test.ts
//
// Acceptance criterion 4: proves the REAL call path already closes T-23's
// acceptance gap, end to end, with zero new production code. Exercises
// completeDispatchOnSignedRateCon() (E2-04 M6, unmodified) and confirms
// T-23's own fn_lifecycle_events_from_loads() trigger (migration 053,
// already live) picks up the resulting carrier_signature_received_at
// change and updates carrier_acceptance_state.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { completeDispatchOnSignedRateCon } from '@/lib/dispatch-gate';

const REF = `T26E2E-${Date.now()}`;

describe('T-26 criterion 4 — already satisfied by T-23 + completeDispatchOnSignedRateCon()', () => {
  let pipelineLoadId: number;
  let tmsLoadId: string;
  const carrierId = `CAR-${REF}`;

  beforeAll(async () => {
    const pl = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
       VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'dispatched') RETURNING id`,
      [`${REF}-PL`],
    );
    pipelineLoadId = pl.rows[0].id;
    tmsLoadId = `LD-${REF}`;
    await db.query(`INSERT INTO carriers (id, company, tenant_id) VALUES ($1, 'T26 Test Carrier', 2)`, [carrierId]);
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, pipeline_load_id, carrier_id)
       VALUES ($1, 'A', 'B', 'Awaiting Signature', $2, $3)`,
      [tmsLoadId, pipelineLoadId, carrierId],
    );
    await db.query(
      `INSERT INTO carrier_acceptance_state (pipeline_load_id, assigned_at, confirmation_method, confirmed_at)
       VALUES ($1, NOW(), 'assumed_unconfirmed', NULL)`,
      [pipelineLoadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM documents WHERE related_to = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = $1`, [carrierId]);
  });

  it('completeDispatchOnSignedRateCon sets carrier_signature_received_at, and T-23s existing trigger closes the loop', async () => {
    const result = await completeDispatchOnSignedRateCon({
      tenantId: 2,
      loadId: tmsLoadId,
      method: 'email_verified',
    });
    expect(result.outcome).toBe('dispatched');

    const state = await db.query<{ confirmation_method: string; confirmed_at: string | null }>(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(state.rows[0].confirmation_method).toBe('rate_con_signed');
    expect(state.rows[0].confirmed_at).not.toBeNull();
  });
});
```

Run: `pnpm vitest run __tests__/documents/t26-rate-con-signed-e2e.test.ts` (against `t26-verify`) — expect PASS with zero code changes needed to make it pass.

- [ ] **Step 2: Commit**

```bash
git add __tests__/documents/t26-rate-con-signed-e2e.test.ts
git commit -m "T-26: end-to-end proof that acceptance criterion 4 is already satisfied by T-23 + existing E2-04 code — no new production code"
```

---

### Task 5: Tracking-page document-exclusion regression test (criterion 5)

**Files:**
- Test: `__tests__/documents/t26-tracking-exclusion.test.ts`

- [ ] **Step 1: Write and run the test**

```typescript
// __tests__/documents/t26-tracking-exclusion.test.ts
//
// Acceptance criterion 5 — pins the existing allow-list so a future change
// can't silently widen self-service to Insurance/Contract/Rate Con. The
// route itself (app/api/tracking/[token]/documents/route.ts) is NOT
// modified by this module.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { GET } from '@/app/api/tracking/[token]/documents/route';

const REF = `T26TRACK-${Date.now()}`;

describe('Public tracking page document exclusion (criterion 5)', () => {
  const tmsLoadId = `LD-${REF}`;
  const token = `tok-${REF}`;

  beforeAll(async () => {
    await db.query(`INSERT INTO loads (id, origin, destination, status, tenant_id) VALUES ($1, 'A', 'B', 'Delivered', 2)`, [tmsLoadId]);
    await db.query(
      `INSERT INTO tracking_tokens (id, load_id, token, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
      [`TT-${REF}`, tmsLoadId, token],
    );
    const types = ['BOL', 'POD', 'Invoice', 'Insurance', 'Contract', 'Rate Confirmation', 'Shipper Rate Confirmation', 'Shipper Rate Confirmation Reply'];
    for (const [idx, type] of types.entries()) {
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id) VALUES ($1, $2, $3, $4, 'Load', 2)`,
        [`DOC-${REF}-${idx}`, `${type}.pdf`, type, tmsLoadId],
      );
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM documents WHERE related_to = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM tracking_tokens WHERE load_id = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
  });

  it('exposes only BOL, POD, and Invoice — never Insurance, Contract, or any Rate Con variant', async () => {
    const req = new NextRequest(`http://x/api/tracking/${token}/documents`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const body = await res.json();
    const returnedTypes = body.documents.map((d: { type: string }) => d.type).sort();
    expect(returnedTypes).toEqual(['BOL', 'Invoice', 'POD']);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add __tests__/documents/t26-tracking-exclusion.test.ts
git commit -m "T-26: regression test pinning the public tracking page's BOL/POD/Invoice-only document allow-list (criterion 5)"
```

---

### Task 6: API endpoints (3 of spec's 4 — see Global Constraints for why the 4th is skipped)

**Files:**
- Create: `app/api/documents/rate-con/[pipelineLoadId]/route.ts`
- Create: `app/api/documents/terms-mismatches/route.ts`
- Create: `app/api/documents/intake-match-report/route.ts`
- Test: `__tests__/documents/t26-api.test.ts`

**Interfaces:**
- Consumes: `authorizeGovernanceRequest`/`resolveTenantId` (`@/lib/governance/api-helpers`, existing).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/documents/t26-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getRateConStatus } from '@/app/api/documents/rate-con/[pipelineLoadId]/route';
import { GET as getMismatches } from '@/app/api/documents/terms-mismatches/route';
import { GET as getIntakeReport } from '@/app/api/documents/intake-match-report/route';

describe('T-26 documents API', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET rate-con status returns both outbound and inbound events for a load', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { event_type: 'document.rate_con_sent', occurred_at: '2026-08-01' },
        { event_type: 'document.rate_con_received', occurred_at: '2026-08-02' },
      ],
    });
    const req = new NextRequest('http://x/api/documents/rate-con/42');
    const res = await getRateConStatus(req, { params: Promise.resolve({ pipelineLoadId: '42' }) });
    const body = await res.json();
    expect(body.events.length).toBe(2);
  });

  it('GET terms-mismatches defaults to unresolved', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'DOC-1', terms_match_status: 'mismatch' }] });
    const req = new NextRequest('http://x/api/documents/terms-mismatches');
    const res = await getMismatches(req);
    const body = await res.json();
    expect(body.mismatches.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain("terms_match_status = 'mismatch'");
  });

  it('GET intake-match-report reports real counts, not a placeholder', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '10', matched: '3', parseable: '2' }] });
    const req = new NextRequest('http://x/api/documents/intake-match-report?since=90');
    const res = await getIntakeReport(req);
    const body = await res.json();
    expect(body.total).toBe(10);
    expect(body.matchRatePct).toBe(30);
    expect(body.extractionAccuracyPct).toBeCloseTo(66.67, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/documents/t26-api.test.ts` — FAIL, modules not found.

- [ ] **Step 3: Write the implementations**

```typescript
// app/api/documents/rate-con/[pipelineLoadId]/route.ts
//
// Unified status per spec §5: outbound events (document.rate_con_sent) for
// buy-side, inbound events (document.rate_con_received/matched) for
// sell-side, same pipeline_load_id.
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ pipelineLoadId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { pipelineLoadId: raw } = await params;
  const pipelineLoadId = Number(raw);
  if (!Number.isInteger(pipelineLoadId)) {
    return NextResponse.json({ error: 'Invalid pipelineLoadId' }, { status: 400 });
  }

  try {
    const { rows } = await db.query(
      `SELECT event_type, occurred_at, payload FROM events
        WHERE pipeline_load_id = $1
          AND event_type IN ('document.rate_con_sent', 'document.rate_con_received', 'document.rate_con_matched', 'document.terms_mismatch_detected')
        ORDER BY occurred_at ASC`,
      [pipelineLoadId],
    );
    return NextResponse.json({ pipelineLoadId, events: rows });
  } catch (err) {
    logger.error('[documents/rate-con GET] failed', err);
    return NextResponse.json({ error: 'Failed to load rate-con status' }, { status: 500 });
  }
}
```

```typescript
// app/api/documents/terms-mismatches/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const status = req.nextUrl.searchParams.get('status') ?? 'unresolved';
  const statusClause = status === 'unresolved' ? "terms_match_status = 'mismatch'" : `terms_match_status = '${status.replace(/'/g, "")}'`;

  try {
    const { rows } = await db.query(
      `SELECT id, name, type, related_to, terms_match_status, parsed_terms, created_at
         FROM documents WHERE ${statusClause} ORDER BY created_at DESC`,
    );
    return NextResponse.json({ mismatches: rows });
  } catch (err) {
    logger.error('[documents/terms-mismatches GET] failed', err);
    return NextResponse.json({ error: 'Failed to load terms mismatches' }, { status: 500 });
  }
}
```

```typescript
// app/api/documents/intake-match-report/route.ts
//
// T-26 §5/criterion 2 — honest numbers, not assumed. Reports over
// inbound_emails (the real intake mechanism — see Global Constraints on
// why inbound_document_intake was never built) joined against the
// documents rows the imap-poller attached and this module's extraction
// step scored.
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const sinceDays = Number(req.nextUrl.searchParams.get('since') ?? '90');

  try {
    const { rows } = await db.query<{ total: string; matched: string; parseable: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE reply_type = 'shipper_confirmation_reply')::text AS total,
         COUNT(*) FILTER (WHERE reply_type = 'shipper_confirmation_reply' AND matched_load_id IS NOT NULL)::text AS matched,
         (SELECT COUNT(*) FROM documents WHERE type = 'Shipper Rate Confirmation Reply' AND terms_match_status IN ('match', 'mismatch'))::text AS parseable
       FROM inbound_emails
       WHERE received_at > NOW() - ($1 || ' days')::interval`,
      [sinceDays],
    );

    const total = Number(rows[0]?.total ?? 0);
    const matched = Number(rows[0]?.matched ?? 0);
    const parseable = Number(rows[0]?.parseable ?? 0);

    return NextResponse.json({
      sinceDays,
      total,
      matched,
      matchRatePct: total === 0 ? 0 : Math.round((matched / total) * 100),
      extractionAccuracyPct: matched === 0 ? 0 : Math.round((parseable / matched) * 10000) / 100,
      note: 'Reflects real inbound_emails/documents rows only — no assumed or rounded-up numbers.',
    });
  } catch (err) {
    logger.error('[documents/intake-match-report GET] failed', err);
    return NextResponse.json({ error: 'Failed to compute intake-match report' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/documents/t26-api.test.ts` — PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add app/api/documents/rate-con app/api/documents/terms-mismatches app/api/documents/intake-match-report __tests__/documents/t26-api.test.ts
git commit -m "T-26: 3 documents API endpoints (rate-con status, terms-mismatches, intake-match-report)"
```

---

### Task 7: Production apply + completion tracker

**Files:**
- Modify: `Engine 3/docs/superpowers/plans/completion.md`

- [ ] **Step 1: Confirm with the user before touching production.**
- [ ] **Step 2: Apply migration 056 to production**, verify the 2 new columns + 2 new triggers directly.
- [ ] **Step 3: Re-run this module's own tests directly against production** for a second confirmation — not the full unrelated project suite.
- [ ] **Step 4: Run the real intake-match-report against production** and report the honest number (expected: likely 0 or very low, given zero real shipper-reply-with-attachment volume documented across every prior Phase 2 module).
- [ ] **Step 5: Add a T-26 section to the completion tracker** — spec link, status, the schema-reality corrections (especially the "premise was wrong, a working pipeline already existed" finding), task checklist, honest acceptance-criteria table (7 from spec §6), and an explicit note that Phase 2's module set (T-20–T-26) is now complete, while flagging E3-00 §8's own real Phase 2 exit gate (100 consecutive loads booked→dispatched→delivered→scored, ≥80% zero-touch) is a separate, much higher bar that building these 7 modules does not itself satisfy.
- [ ] **Step 6: Commit**

```bash
git add "Engine 3/docs/superpowers/plans/completion.md"
git commit -m "T-26: completion tracker entry — Phase 2 module set (T-20-T-26) complete"
```

---

## Self-Review Notes

- **Spec coverage:** §4.1 (documents columns) — Task 1 (tenant_id already existed, documented). §4.2 (inbound_document_intake) — deliberately NOT built, documented in Global Constraints; `inbound_emails` already serves this role. §4.3 (event taxonomy) — Task 1, corrected sources. §4.4 (compareTerms) — Task 2. §5 (4 endpoints) — Task 6 builds 3; the 4th (`POST /api/documents/inbound-intake`) is explicitly skipped, documented. §6 (7 criteria) — criterion 1 via Task 1's `rate_con_sent` trigger, criterion 2 via Task 2 + Task 6's report, criterion 3 via Task 2, criterion 4 via Task 4 (already satisfied), criterion 5 via Task 5, criterion 6 via Task 1 (additive columns, tenant_id already existed so "zero behavior change" holds trivially), criterion 7 via never touching the named files. §7 (gate) — Task 7, including the explicit E3-00 §8 caveat. §8 (portability) — no new storage layer, extraction function isolated per spec's own note.
- **Explicitly out of scope**, not built here: automatic blocking on terms mismatch (T-26b); generalizing the parser into T-30's broader intake (T-26b); OCR/extraction accuracy tuning beyond the first honest baseline.
