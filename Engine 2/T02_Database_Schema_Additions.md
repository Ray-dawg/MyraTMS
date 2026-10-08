# T-02: DATABASE SCHEMA — ADDITIONS & MIGRATIONS

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

This document defines every new table, column addition, and index needed to support the AI agent pipeline (Engine 2), consent/compliance tracking, call logging, and the learning loop. All schemas are defined for Neon PostgreSQL. Migration scripts should be run in order.

---

## 1. New Tables Overview

| Table | Purpose | Agent Dependency |
|---|---|---|
| `pipeline_loads` | Tracks every load through the 7-agent pipeline stages | All agents |
| `agent_calls` | Logs every AI voice call with structured outcomes | Agent 6 (Voice), Agent 12 (Parser) |
| `negotiation_briefs` | Stores the complete JSON brief per load | Agent 5 (Compiler), Agent 6 (Voice) |
| `consent_log` | CASL/TCPA compliance tracking per phone number | Pre-call compliance check |
| `dnc_list` | Do-not-call registry | Pre-call compliance check |
| `shipper_preferences` | Learned preferences: language, currency, units | Agent 6 (Voice), Scanner |
| `lane_stats` | Aggregated lane performance for the learning loop | Feedback Agent |
| `personas` | Voice agent persona configs with A/B testing metrics | Agent 5 (Compiler), Agent 6 (Voice) |
| `agent_jobs` | Job queue state tracking (BullMQ companion) | Orchestration backbone |

---

## 2. Table Definitions

### 2.1 pipeline_loads

The central state machine table. Every load entering the pipeline gets a row. The `stage` column advances as agents process it.

```sql
CREATE TABLE pipeline_loads (
    id SERIAL PRIMARY KEY,
    
    -- Load identification
    load_id VARCHAR(100) NOT NULL,
    load_board_source VARCHAR(50) NOT NULL,
    external_load_id VARCHAR(100),
    
    -- Core load data (normalized from any source)
    origin_city VARCHAR(100) NOT NULL,
    origin_state VARCHAR(10) NOT NULL,
    origin_country VARCHAR(2) DEFAULT 'CA',
    destination_city VARCHAR(100) NOT NULL,
    destination_state VARCHAR(10) NOT NULL,
    destination_country VARCHAR(2) DEFAULT 'CA',
    pickup_date TIMESTAMP NOT NULL,
    delivery_date TIMESTAMP,
    equipment_type VARCHAR(50) NOT NULL,
    commodity VARCHAR(200),
    weight_lbs INTEGER,
    distance_miles INTEGER,
    distance_km INTEGER,
    
    -- Shipper contact
    shipper_company VARCHAR(200),
    shipper_contact_name VARCHAR(200),
    shipper_phone VARCHAR(30),
    shipper_email VARCHAR(200),
    
    -- Posted rate info
    posted_rate DECIMAL(10,2),
    posted_rate_currency VARCHAR(3) DEFAULT 'CAD',
    rate_type VARCHAR(20) DEFAULT 'all_in',
    
    -- Pipeline stage tracking
    stage VARCHAR(30) NOT NULL DEFAULT 'scanned',
    stage_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Qualification results (Agent 2)
    has_carrier_match BOOLEAN,
    estimated_margin_low DECIMAL(10,2),
    estimated_margin_high DECIMAL(10,2),
    priority_score INTEGER,
    qualification_reason VARCHAR(200),
    
    -- Research results (Agent 3) — stored as reference, full detail in negotiation_briefs
    research_completed_at TIMESTAMP,
    market_rate_floor DECIMAL(10,2),
    market_rate_mid DECIMAL(10,2),
    market_rate_best DECIMAL(10,2),
    recommended_strategy VARCHAR(20),
    
    -- Matching results (Agent 4)
    carrier_match_count INTEGER DEFAULT 0,
    top_carrier_id INTEGER,
    
    -- Call results (Agent 6)
    call_attempts INTEGER DEFAULT 0,
    last_call_at TIMESTAMP,
    call_outcome VARCHAR(30),
    agreed_rate DECIMAL(10,2),
    agreed_rate_currency VARCHAR(3),
    
    -- Booking results
    profit DECIMAL(10,2),
    profit_margin_pct DECIMAL(5,2),
    auto_booked BOOLEAN DEFAULT false,
    booked_at TIMESTAMP,
    
    -- Dispatch linkage
    tms_load_id INTEGER,
    dispatched_at TIMESTAMP,
    delivered_at TIMESTAMP,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(50) DEFAULT 'scanner',
    notes TEXT,
    
    -- Deduplication
    UNIQUE (load_id, load_board_source)
);

-- Stage progression index (most common query pattern)
CREATE INDEX idx_pipeline_loads_stage ON pipeline_loads(stage);
CREATE INDEX idx_pipeline_loads_stage_updated ON pipeline_loads(stage, stage_updated_at);

-- Lookup by source
CREATE INDEX idx_pipeline_loads_source ON pipeline_loads(load_board_source, created_at DESC);

-- Priority ordering within stage
CREATE INDEX idx_pipeline_loads_priority ON pipeline_loads(stage, priority_score DESC);

-- Phone lookup for dedup and consent
CREATE INDEX idx_pipeline_loads_phone ON pipeline_loads(shipper_phone);

-- Date range queries
CREATE INDEX idx_pipeline_loads_created ON pipeline_loads(created_at DESC);
CREATE INDEX idx_pipeline_loads_pickup ON pipeline_loads(pickup_date);
```

**Valid stage values:**

```
scanned        → Load ingested from load board, not yet evaluated
qualified      → Passed Agent 2 filters, has profit potential
disqualified   → Failed Agent 2 filters, dead
researched     → Agent 3 completed rate analysis
matched        → Agent 4 ranked carriers
briefed        → Agent 5 compiled negotiation brief
calling        → Agent 6 is actively on a call
booked         → Call succeeded, load booked
declined       → Call completed, shipper declined
escalated      → Agent couldn't resolve, needs human review
dispatched     → Load created in TMS, carrier assigned
delivered      → Load delivered, POD captured
scored         → Feedback agent processed post-delivery data
expired        → Load aged out (pickup date passed without booking)
```

---

### 2.2 agent_calls

Every voice call the system makes, with structured outcome data.

```sql
CREATE TABLE agent_calls (
    id SERIAL PRIMARY KEY,
    
    -- Linkage
    pipeline_load_id INTEGER REFERENCES pipeline_loads(id),
    call_id VARCHAR(100) UNIQUE NOT NULL,
    
    -- Call metadata
    call_type VARCHAR(30) NOT NULL,
    persona VARCHAR(30),
    language VARCHAR(10) DEFAULT 'en',
    currency VARCHAR(3) DEFAULT 'CAD',
    
    -- Retell metadata
    retell_call_id VARCHAR(100),
    retell_agent_id VARCHAR(100),
    phone_number_called VARCHAR(30),
    
    -- Timing
    call_initiated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    call_connected_at TIMESTAMP,
    call_ended_at TIMESTAMP,
    duration_seconds INTEGER,
    
    -- Brief used (what the agent was told to do)
    negotiation_brief_id INTEGER,
    initial_offer DECIMAL(10,2),
    min_acceptable_rate DECIMAL(10,2),
    target_rate DECIMAL(10,2),
    
    -- Outcome (parsed from transcript)
    outcome VARCHAR(30),
    agreed_rate DECIMAL(10,2),
    profit DECIMAL(10,2),
    profit_tier VARCHAR(20),
    auto_book_eligible BOOLEAN DEFAULT false,
    
    -- Conversation analysis
    sentiment VARCHAR(20),
    objections JSONB DEFAULT '[]'::jsonb,
    concessions_made INTEGER DEFAULT 0,
    
    -- Next actions
    next_action VARCHAR(50),
    callback_scheduled_at TIMESTAMP,
    decision_maker_name VARCHAR(200),
    decision_maker_phone VARCHAR(30),
    decision_maker_email VARCHAR(200),
    
    -- Transcript and recording
    transcript TEXT,
    recording_url VARCHAR(500),
    call_analysis JSONB,
    
    -- Quality
    call_quality_score INTEGER,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_agent_calls_pipeline_load ON agent_calls(pipeline_load_id);
CREATE INDEX idx_agent_calls_outcome ON agent_calls(outcome);
CREATE INDEX idx_agent_calls_persona ON agent_calls(persona);
CREATE INDEX idx_agent_calls_created ON agent_calls(created_at DESC);
CREATE INDEX idx_agent_calls_phone ON agent_calls(phone_number_called);
CREATE INDEX idx_agent_calls_callback ON agent_calls(callback_scheduled_at) WHERE callback_scheduled_at IS NOT NULL;
```

**Valid outcome values:**

```
booked          → Rate agreed, load booked
declined        → Full conversation, shipper said no
counter_pending → Shipper countered outside envelope, needs human review
callback        → Shipper requested callback at specific time
voicemail       → Reached voicemail, left message
no_answer       → Phone rang, no answer, no voicemail
wrong_contact   → Reached someone who isn't the decision-maker
escalated       → Agent hit a scenario it couldn't handle
dropped         → Call dropped or technical failure
busy            → Line busy
```

---

### 2.3 negotiation_briefs

The complete JSON document that Agent 6 receives before making a call.

```sql
CREATE TABLE negotiation_briefs (
    id SERIAL PRIMARY KEY,
    
    -- Linkage
    pipeline_load_id INTEGER REFERENCES pipeline_loads(id) NOT NULL,
    
    -- The brief itself (complete JSON — see T-08 for schema)
    brief JSONB NOT NULL,
    
    -- Brief metadata
    brief_version VARCHAR(10) DEFAULT '1.0',
    persona_selected VARCHAR(30),
    strategy VARCHAR(20),
    
    -- Rate envelope summary (denormalized for quick queries)
    initial_offer DECIMAL(10,2),
    target_rate DECIMAL(10,2),
    min_acceptable_rate DECIMAL(10,2),
    concession_step_1 DECIMAL(10,2),
    concession_step_2 DECIMAL(10,2),
    final_offer DECIMAL(10,2),
    
    -- Carrier stack summary
    carrier_count INTEGER,
    top_carrier_id INTEGER,
    top_carrier_rate DECIMAL(10,2),
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    used_at TIMESTAMP,
    call_id VARCHAR(100)
);

CREATE INDEX idx_briefs_pipeline_load ON negotiation_briefs(pipeline_load_id);
CREATE INDEX idx_briefs_created ON negotiation_briefs(created_at DESC);
```

---

### 2.4 consent_log

CASL and TCPA compliance tracking. Every outbound call must pass a consent check first.

```sql
CREATE TABLE consent_log (
    id SERIAL PRIMARY KEY,
    
    phone VARCHAR(30) NOT NULL,
    
    -- Consent details
    consent_type VARCHAR(30) NOT NULL,
    consent_source VARCHAR(100) NOT NULL,
    consent_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    consent_proof TEXT,
    
    -- Validity
    expires_at TIMESTAMP,
    revoked_at TIMESTAMP,
    revoked_reason VARCHAR(200),
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_consent_phone ON consent_log(phone);
CREATE INDEX idx_consent_active ON consent_log(phone, revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_consent_expiry ON consent_log(expires_at) WHERE expires_at IS NOT NULL;
```

**Valid consent_type values:**

```
implied_load_post    → Shipper posted on load board (implied consent to call about that load)
implied_business     → Existing business relationship
explicit_written     → Written consent obtained (required for CASL cold outreach)
explicit_verbal      → Verbal consent obtained during a call
opt_in_form          → Submitted via website or onboarding form
```

**Valid consent_source values:**

```
dat_load_post        → Load posted on DAT
123lb_load_post      → Load posted on 123Loadboard
truckstop_load_post  → Load posted on Truckstop
website_form         → Myra website get-started form
manual_entry         → Manually entered by Patrice
call_recording       → Consent captured during a recorded call
```

---

### 2.5 dnc_list

Do-not-call registry. Checked before every outbound call. Never call a number on this list.

```sql
CREATE TABLE dnc_list (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(30) UNIQUE NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    source VARCHAR(50) NOT NULL,
    reason VARCHAR(200),
    added_by VARCHAR(50) DEFAULT 'system',
    notes TEXT
);

CREATE INDEX idx_dnc_phone ON dnc_list(phone);
```

**Valid source values:**

```
opt_out_during_call  → Shipper requested removal during AI call
opt_out_email        → Shipper emailed requesting removal
manual_entry         → Patrice manually added
regulatory_list      → Imported from CRTC or FTC DNC registry
complaint            → Added after shipper complaint
```

---

### 2.6 shipper_preferences

Learned preferences per phone number. Updated after calls to improve future interactions.

```sql
CREATE TABLE shipper_preferences (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(30) UNIQUE NOT NULL,
    
    preferred_language VARCHAR(10),
    preferred_currency VARCHAR(3),
    preferred_units VARCHAR(10),
    preferred_contact_time VARCHAR(20),
    
    -- Behavioral data
    total_calls_received INTEGER DEFAULT 0,
    total_bookings INTEGER DEFAULT 0,
    avg_agreed_rate DECIMAL(10,2),
    last_objection_type VARCHAR(50),
    best_performing_persona VARCHAR(30),
    
    -- Shipper profile
    company_name VARCHAR(200),
    contact_name VARCHAR(200),
    shipper_tier VARCHAR(20),
    
    -- Metadata
    learned_from_call_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_shipper_prefs_phone ON shipper_preferences(phone);
```

---

### 2.7 lane_stats

Aggregated performance data per lane. Updated nightly by the Feedback Agent. Used by Agent 3 (Researcher) to improve rate predictions and by Agent 5 (Compiler) for persona selection.

```sql
CREATE TABLE lane_stats (
    id SERIAL PRIMARY KEY,
    
    -- Lane definition
    lane VARCHAR(200) NOT NULL,
    origin_city VARCHAR(100),
    origin_state VARCHAR(10),
    destination_city VARCHAR(100),
    destination_state VARCHAR(10),
    equipment_type VARCHAR(50),
    
    -- Segmentation
    persona VARCHAR(30),
    day_of_week INTEGER,
    hour_of_day INTEGER,
    
    -- Rate intelligence
    avg_posted_rate DECIMAL(10,2),
    avg_agreed_rate DECIMAL(10,2),
    avg_profit DECIMAL(10,2),
    rate_std_dev DECIMAL(10,2),
    min_agreed_rate DECIMAL(10,2),
    max_agreed_rate DECIMAL(10,2),
    
    -- Performance
    total_calls INTEGER DEFAULT 0,
    booked_count INTEGER DEFAULT 0,
    booking_rate DECIMAL(5,4) DEFAULT 0,
    avg_call_duration_sec INTEGER,
    
    -- Adjustment factor (learning loop output)
    rate_adjustment_factor DECIMAL(5,3) DEFAULT 0.000,
    
    -- Metadata
    period_start DATE,
    period_end DATE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE (lane, persona, day_of_week, hour_of_day, equipment_type)
);

CREATE INDEX idx_lane_stats_lane ON lane_stats(lane);
CREATE INDEX idx_lane_stats_booking ON lane_stats(booking_rate DESC);
CREATE INDEX idx_lane_stats_updated ON lane_stats(updated_at DESC);
```

---

### 2.8 personas

Voice agent persona configurations with A/B testing metrics. Thompson Sampling uses total_calls and total_bookings to compute selection probability.

```sql
CREATE TABLE personas (
    id SERIAL PRIMARY KEY,
    
    persona_name VARCHAR(30) UNIQUE NOT NULL,
    
    -- Retell agent configuration
    retell_agent_id_en VARCHAR(100),
    retell_agent_id_fr VARCHAR(100),
    
    -- Persona definition
    description TEXT,
    tone VARCHAR(50),
    prompt_template TEXT NOT NULL,
    prompt_template_fr TEXT,
    
    -- Voice settings
    voice_id VARCHAR(100),
    voice_settings JSONB,
    
    -- A/B testing metrics
    is_active BOOLEAN DEFAULT true,
    total_calls INTEGER DEFAULT 0,
    total_bookings INTEGER DEFAULT 0,
    total_revenue DECIMAL(12,2) DEFAULT 0,
    avg_profit DECIMAL(10,2) DEFAULT 0,
    booking_rate DECIMAL(5,4) DEFAULT 0,
    avg_call_duration_sec INTEGER DEFAULT 0,
    
    -- Thompson Sampling parameters
    alpha DECIMAL(10,2) DEFAULT 1.0,
    beta DECIMAL(10,2) DEFAULT 1.0,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

### 2.9 agent_jobs

Companion table to BullMQ for pipeline observability. Every job that enters a queue gets a row. This provides visibility into the pipeline state without querying Redis directly.

```sql
CREATE TABLE agent_jobs (
    id SERIAL PRIMARY KEY,
    
    job_id VARCHAR(100) UNIQUE NOT NULL,
    queue_name VARCHAR(50) NOT NULL,
    pipeline_load_id INTEGER REFERENCES pipeline_loads(id),
    
    -- Job state
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    priority INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    
    -- Timing
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    failed_at TIMESTAMP,
    
    -- Result
    result JSONB,
    error_message TEXT,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_agent_jobs_queue ON agent_jobs(queue_name, status);
CREATE INDEX idx_agent_jobs_pipeline ON agent_jobs(pipeline_load_id);
CREATE INDEX idx_agent_jobs_status ON agent_jobs(status);
```

**Valid status values:** `queued`, `active`, `completed`, `failed`, `dead_letter`

---

## 3. Column Additions to Existing Tables

### 3.1 loads table (existing)

Add columns to link TMS loads back to pipeline loads:

```sql
ALTER TABLE loads
    ADD COLUMN pipeline_load_id INTEGER,
    ADD COLUMN source_type VARCHAR(20) DEFAULT 'manual',
    ADD COLUMN booked_via VARCHAR(20) DEFAULT 'human';
```

`source_type`: `manual` (Patrice created it) | `ai_agent` (booked by voice agent) | `load_board_import` (one-click import)

`booked_via`: `human` | `ai_auto` | `ai_escalated`

### 3.2 carriers table (existing)

Add columns for agent pipeline compatibility:

```sql
ALTER TABLE carriers
    ADD COLUMN accepts_ai_dispatch BOOLEAN DEFAULT true,
    ADD COLUMN preferred_contact_method VARCHAR(20) DEFAULT 'phone',
    ADD COLUMN ai_call_count INTEGER DEFAULT 0,
    ADD COLUMN ai_acceptance_rate DECIMAL(5,4);
```

### 3.3 shippers table (existing)

Add columns for pipeline and consent tracking:

```sql
ALTER TABLE shippers
    ADD COLUMN consent_status VARCHAR(20),
    ADD COLUMN preferred_language VARCHAR(10) DEFAULT 'en',
    ADD COLUMN ai_interaction_count INTEGER DEFAULT 0,
    ADD COLUMN last_ai_call_at TIMESTAMP,
    ADD COLUMN shipper_fatigue_score INTEGER DEFAULT 0;
```

`shipper_fatigue_score`: Increments when calls are declined. Resets after successful booking. Agent pipeline checks this before calling — if score > 2, wait 7 days before retry.

---

## 4. Migration Execution Order

Run these migrations in sequence. Each is idempotent (uses IF NOT EXISTS or ON CONFLICT).

```
Migration 001: Create pipeline_loads table
Migration 002: Create agent_calls table
Migration 003: Create negotiation_briefs table
Migration 004: Create consent_log table
Migration 005: Create dnc_list table
Migration 006: Create shipper_preferences table
Migration 007: Create lane_stats table
Migration 008: Create personas table
Migration 009: Create agent_jobs table
Migration 010: Alter existing loads table
Migration 011: Alter existing carriers table
Migration 012: Alter existing shippers table
Migration 013: Seed personas table with 3 default personas
```

---

## 5. Seed Data — Default Personas

```sql
INSERT INTO personas (persona_name, description, tone, prompt_template, is_active, alpha, beta)
VALUES 
    ('assertive', 'Direct, confident, time-efficient. Gets to the rate quickly.', 'direct', '[PROMPT FROM C-04]', true, 1.0, 1.0),
    ('friendly', 'Warm, personable, conversational. Builds rapport first.', 'warm', '[PROMPT FROM C-04]', true, 1.0, 1.0),
    ('analytical', 'Precise, data-driven, methodical. Leads with market data.', 'precise', '[PROMPT FROM C-04]', true, 1.0, 1.0);
```

---

## 6. Data Retention Policy

| Table | Retention | Archive Strategy |
|---|---|---|
| pipeline_loads | 2 years | Archive to cold storage after 6 months |
| agent_calls | 2 years (transcripts), 90 days (recordings) | Delete recordings after 90 days, keep transcripts |
| negotiation_briefs | 1 year | Archive to cold storage |
| consent_log | 3 years (CASL requirement) | Never delete during retention period |
| dnc_list | Indefinite | Never delete unless explicitly requested |
| shipper_preferences | Indefinite | Update, never delete |
| lane_stats | 1 year rolling | Older data aggregated into quarterly summaries |
| personas | Indefinite | Soft delete only (is_active = false) |
| agent_jobs | 30 days | Purge completed/failed jobs older than 30 days |

---

*End of document. Run migrations in order. Seed personas before first agent test.*
