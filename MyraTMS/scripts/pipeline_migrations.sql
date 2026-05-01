-- ============================================================================
-- MYRA LOGISTICS — CONSOLIDATED PIPELINE MIGRATIONS
-- ============================================================================
-- Source:    T-02 Database Schema Additions & Migrations
-- Target:    Neon PostgreSQL (serverless)
-- Version:   1.0
-- Date:      2026-04-03
-- Owner:     Patrice Penda
--
-- This file consolidates all 13 migrations required for the AI Agent Pipeline
-- (Engine 2). Run once against your Neon database. Every statement uses
-- IF NOT EXISTS or IF NOT EXISTS column checks so re-running is safe.
--
-- Migration order:
--   001  pipeline_loads         — Central state machine table
--   002  agent_calls            — Voice call log with structured outcomes
--   003  negotiation_briefs     — JSON briefs per load
--   004  consent_log            — CASL/TCPA compliance tracking
--   005  dnc_list               — Do-not-call registry
--   006  shipper_preferences    — Learned preferences per phone
--   007  lane_stats             — Aggregated lane performance
--   008  personas               — Voice agent persona configs + A/B metrics
--   009  agent_jobs             — BullMQ companion for pipeline observability
--   010  ALTER loads            — Link TMS loads to pipeline
--   011  ALTER carriers         — Agent pipeline compatibility columns
--   012  ALTER shippers         — Consent + fatigue tracking columns
--   013  SEED personas          — 3 default personas
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 001: pipeline_loads
-- The central state machine. Every load entering the pipeline gets a row.
-- Valid stages: scanned → qualified → disqualified → researched → matched →
--   briefed → calling → booked → declined → escalated → dispatched →
--   delivered → scored → expired
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS pipeline_loads (
    id                      SERIAL PRIMARY KEY,

    -- Load identification
    load_id                 VARCHAR(100) NOT NULL,
    load_board_source       VARCHAR(50)  NOT NULL,
    external_load_id        VARCHAR(100),

    -- Core load data (normalized from any source)
    origin_city             VARCHAR(100) NOT NULL,
    origin_state            VARCHAR(10)  NOT NULL,
    origin_country          VARCHAR(2)   DEFAULT 'CA',
    destination_city        VARCHAR(100) NOT NULL,
    destination_state       VARCHAR(10)  NOT NULL,
    destination_country     VARCHAR(2)   DEFAULT 'CA',
    pickup_date             TIMESTAMP    NOT NULL,
    delivery_date           TIMESTAMP,
    equipment_type          VARCHAR(50)  NOT NULL,
    commodity               VARCHAR(200),
    weight_lbs              INTEGER,
    distance_miles          INTEGER,
    distance_km             INTEGER,

    -- Shipper contact
    shipper_company         VARCHAR(200),
    shipper_contact_name    VARCHAR(200),
    shipper_phone           VARCHAR(30),
    shipper_email           VARCHAR(200),

    -- Posted rate info
    posted_rate             DECIMAL(10,2),
    posted_rate_currency    VARCHAR(3)   DEFAULT 'CAD',
    rate_type               VARCHAR(20)  DEFAULT 'all_in',

    -- Pipeline stage tracking
    stage                   VARCHAR(30)  NOT NULL DEFAULT 'scanned',
    stage_updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,

    -- Qualification results (Agent 2)
    has_carrier_match       BOOLEAN,
    estimated_margin_low    DECIMAL(10,2),
    estimated_margin_high   DECIMAL(10,2),
    priority_score          INTEGER,
    qualification_reason    VARCHAR(200),

    -- Research results (Agent 3)
    research_completed_at   TIMESTAMP,
    market_rate_floor       DECIMAL(10,2),
    market_rate_mid         DECIMAL(10,2),
    market_rate_best        DECIMAL(10,2),
    recommended_strategy    VARCHAR(20),

    -- Matching results (Agent 4)
    carrier_match_count     INTEGER      DEFAULT 0,
    top_carrier_id          INTEGER,

    -- Call results (Agent 6)
    call_attempts           INTEGER      DEFAULT 0,
    last_call_at            TIMESTAMP,
    call_outcome            VARCHAR(30),
    agreed_rate             DECIMAL(10,2),
    agreed_rate_currency    VARCHAR(3),

    -- Booking results
    profit                  DECIMAL(10,2),
    profit_margin_pct       DECIMAL(5,2),
    auto_booked             BOOLEAN      DEFAULT false,
    booked_at               TIMESTAMP,

    -- Dispatch linkage
    tms_load_id             INTEGER,
    dispatched_at           TIMESTAMP,
    delivered_at            TIMESTAMP,

    -- Metadata
    created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by              VARCHAR(50)  DEFAULT 'scanner',
    notes                   TEXT,

    -- Deduplication
    UNIQUE (load_id, load_board_source)
);

-- Indexes for pipeline_loads
CREATE INDEX IF NOT EXISTS idx_pipeline_loads_stage
    ON pipeline_loads(stage);

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_stage_updated
    ON pipeline_loads(stage, stage_updated_at);

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_source
    ON pipeline_loads(load_board_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_priority
    ON pipeline_loads(stage, priority_score DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_phone
    ON pipeline_loads(shipper_phone);

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_created
    ON pipeline_loads(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_pickup
    ON pipeline_loads(pickup_date);

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 002: agent_calls
-- Every voice call the system makes, with structured outcome data.
-- Valid outcomes: booked | declined | counter_pending | callback |
--   voicemail | no_answer | wrong_contact | escalated | dropped | busy
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS agent_calls (
    id                      SERIAL PRIMARY KEY,

    -- Linkage
    pipeline_load_id        INTEGER REFERENCES pipeline_loads(id),
    call_id                 VARCHAR(100) UNIQUE NOT NULL,

    -- Call metadata
    call_type               VARCHAR(30)  NOT NULL,
    persona                 VARCHAR(30),
    language                VARCHAR(10)  DEFAULT 'en',
    currency                VARCHAR(3)   DEFAULT 'CAD',

    -- Retell metadata
    retell_call_id          VARCHAR(100),
    retell_agent_id         VARCHAR(100),
    phone_number_called     VARCHAR(30),

    -- Timing
    call_initiated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    call_connected_at       TIMESTAMP,
    call_ended_at           TIMESTAMP,
    duration_seconds        INTEGER,

    -- Brief used (what the agent was told to do)
    negotiation_brief_id    INTEGER,
    initial_offer           DECIMAL(10,2),
    min_acceptable_rate     DECIMAL(10,2),
    target_rate             DECIMAL(10,2),

    -- Outcome (parsed from transcript)
    outcome                 VARCHAR(30),
    agreed_rate             DECIMAL(10,2),
    profit                  DECIMAL(10,2),
    profit_tier             VARCHAR(20),
    auto_book_eligible      BOOLEAN      DEFAULT false,

    -- Conversation analysis
    sentiment               VARCHAR(20),
    objections              JSONB        DEFAULT '[]'::jsonb,
    concessions_made        INTEGER      DEFAULT 0,

    -- Next actions
    next_action             VARCHAR(50),
    callback_scheduled_at   TIMESTAMP,
    decision_maker_name     VARCHAR(200),
    decision_maker_phone    VARCHAR(30),
    decision_maker_email    VARCHAR(200),

    -- Transcript and recording
    transcript              TEXT,
    recording_url           VARCHAR(500),
    call_analysis           JSONB,

    -- Quality
    call_quality_score      INTEGER,

    -- Metadata
    created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for agent_calls
CREATE INDEX IF NOT EXISTS idx_agent_calls_pipeline_load
    ON agent_calls(pipeline_load_id);

CREATE INDEX IF NOT EXISTS idx_agent_calls_outcome
    ON agent_calls(outcome);

CREATE INDEX IF NOT EXISTS idx_agent_calls_persona
    ON agent_calls(persona);

CREATE INDEX IF NOT EXISTS idx_agent_calls_created
    ON agent_calls(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_calls_phone
    ON agent_calls(phone_number_called);

CREATE INDEX IF NOT EXISTS idx_agent_calls_callback
    ON agent_calls(callback_scheduled_at)
    WHERE callback_scheduled_at IS NOT NULL;

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 003: negotiation_briefs
-- The complete JSON document Agent 6 receives before making a call.
-- See T-08 Brief Compiler spec for the JSON schema.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS negotiation_briefs (
    id                      SERIAL PRIMARY KEY,

    -- Linkage
    pipeline_load_id        INTEGER REFERENCES pipeline_loads(id) NOT NULL,

    -- The brief itself (complete JSON — see T-08 for schema)
    brief                   JSONB        NOT NULL,

    -- Brief metadata
    brief_version           VARCHAR(10)  DEFAULT '1.0',
    persona_selected        VARCHAR(30),
    strategy                VARCHAR(20),

    -- Rate envelope summary (denormalized for quick queries)
    initial_offer           DECIMAL(10,2),
    target_rate             DECIMAL(10,2),
    min_acceptable_rate     DECIMAL(10,2),
    concession_step_1       DECIMAL(10,2),
    concession_step_2       DECIMAL(10,2),
    final_offer             DECIMAL(10,2),

    -- Carrier stack summary
    carrier_count           INTEGER,
    top_carrier_id          INTEGER,
    top_carrier_rate        DECIMAL(10,2),

    -- Metadata
    created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    used_at                 TIMESTAMP,
    call_id                 VARCHAR(100)
);

-- Indexes for negotiation_briefs
CREATE INDEX IF NOT EXISTS idx_briefs_pipeline_load
    ON negotiation_briefs(pipeline_load_id);

CREATE INDEX IF NOT EXISTS idx_briefs_created
    ON negotiation_briefs(created_at DESC);

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 004: consent_log
-- CASL and TCPA compliance tracking. Every outbound call must pass a
-- consent check first.
--
-- Valid consent_type:
--   implied_load_post | implied_business | explicit_written |
--   explicit_verbal   | opt_in_form
--
-- Valid consent_source:
--   dat_load_post | 123lb_load_post | truckstop_load_post |
--   website_form  | manual_entry    | call_recording
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS consent_log (
    id                      SERIAL PRIMARY KEY,

    phone                   VARCHAR(30)  NOT NULL,

    -- Consent details
    consent_type            VARCHAR(30)  NOT NULL,
    consent_source          VARCHAR(100) NOT NULL,
    consent_date            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    consent_proof           TEXT,

    -- Validity
    expires_at              TIMESTAMP,
    revoked_at              TIMESTAMP,
    revoked_reason          VARCHAR(200),

    -- Metadata
    created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for consent_log
CREATE INDEX IF NOT EXISTS idx_consent_phone
    ON consent_log(phone);

CREATE INDEX IF NOT EXISTS idx_consent_active
    ON consent_log(phone, revoked_at)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_consent_expiry
    ON consent_log(expires_at)
    WHERE expires_at IS NOT NULL;

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 005: dnc_list
-- Do-not-call registry. Checked before every outbound call.
-- Never call a number on this list.
--
-- Valid source values:
--   opt_out_during_call | opt_out_email | manual_entry |
--   regulatory_list     | complaint
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS dnc_list (
    id                      SERIAL PRIMARY KEY,
    phone                   VARCHAR(30)  UNIQUE NOT NULL,
    added_at                TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    source                  VARCHAR(50)  NOT NULL,
    reason                  VARCHAR(200),
    added_by                VARCHAR(50)  DEFAULT 'system',
    notes                   TEXT
);

-- Indexes for dnc_list
CREATE INDEX IF NOT EXISTS idx_dnc_phone
    ON dnc_list(phone);

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 006: shipper_preferences
-- Learned preferences per phone number. Updated after calls to improve
-- future interactions.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS shipper_preferences (
    id                          SERIAL PRIMARY KEY,
    phone                       VARCHAR(30)  UNIQUE NOT NULL,

    preferred_language          VARCHAR(10),
    preferred_currency          VARCHAR(3),
    preferred_units             VARCHAR(10),
    preferred_contact_time      VARCHAR(20),

    -- Behavioral data
    total_calls_received        INTEGER      DEFAULT 0,
    total_bookings              INTEGER      DEFAULT 0,
    avg_agreed_rate             DECIMAL(10,2),
    last_objection_type         VARCHAR(50),
    best_performing_persona     VARCHAR(30),

    -- Shipper profile
    company_name                VARCHAR(200),
    contact_name                VARCHAR(200),
    shipper_tier                VARCHAR(20),

    -- Metadata
    learned_from_call_id        VARCHAR(100),
    created_at                  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for shipper_preferences
CREATE INDEX IF NOT EXISTS idx_shipper_prefs_phone
    ON shipper_preferences(phone);

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 007: lane_stats
-- Aggregated performance data per lane. Updated nightly by the Feedback
-- Agent. Used by Agent 3 (Researcher) for rate predictions and Agent 5
-- (Compiler) for persona selection.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS lane_stats (
    id                      SERIAL PRIMARY KEY,

    -- Lane definition
    lane                    VARCHAR(200) NOT NULL,
    origin_city             VARCHAR(100),
    origin_state            VARCHAR(10),
    destination_city        VARCHAR(100),
    destination_state       VARCHAR(10),
    equipment_type          VARCHAR(50),

    -- Segmentation
    persona                 VARCHAR(30),
    day_of_week             INTEGER,
    hour_of_day             INTEGER,

    -- Rate intelligence
    avg_posted_rate         DECIMAL(10,2),
    avg_agreed_rate         DECIMAL(10,2),
    avg_profit              DECIMAL(10,2),
    rate_std_dev            DECIMAL(10,2),
    min_agreed_rate         DECIMAL(10,2),
    max_agreed_rate         DECIMAL(10,2),

    -- Performance
    total_calls             INTEGER      DEFAULT 0,
    booked_count            INTEGER      DEFAULT 0,
    booking_rate            DECIMAL(5,4) DEFAULT 0,
    avg_call_duration_sec   INTEGER,

    -- Adjustment factor (learning loop output)
    rate_adjustment_factor  DECIMAL(5,3) DEFAULT 0.000,

    -- Metadata
    period_start            DATE,
    period_end              DATE,
    updated_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (lane, persona, day_of_week, hour_of_day, equipment_type)
);

-- Indexes for lane_stats
CREATE INDEX IF NOT EXISTS idx_lane_stats_lane
    ON lane_stats(lane);

CREATE INDEX IF NOT EXISTS idx_lane_stats_booking
    ON lane_stats(booking_rate DESC);

CREATE INDEX IF NOT EXISTS idx_lane_stats_updated
    ON lane_stats(updated_at DESC);

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 008: personas
-- Voice agent persona configurations with A/B testing metrics.
-- Thompson Sampling uses total_calls and total_bookings (alpha/beta)
-- to compute selection probability.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS personas (
    id                      SERIAL PRIMARY KEY,

    persona_name            VARCHAR(30)  UNIQUE NOT NULL,

    -- Retell agent configuration
    retell_agent_id_en      VARCHAR(100),
    retell_agent_id_fr      VARCHAR(100),

    -- Persona definition
    description             TEXT,
    tone                    VARCHAR(50),
    prompt_template         TEXT         NOT NULL,
    prompt_template_fr      TEXT,

    -- Voice settings
    voice_id                VARCHAR(100),
    voice_settings          JSONB,

    -- A/B testing metrics
    is_active               BOOLEAN      DEFAULT true,
    total_calls             INTEGER      DEFAULT 0,
    total_bookings          INTEGER      DEFAULT 0,
    total_revenue           DECIMAL(12,2) DEFAULT 0,
    avg_profit              DECIMAL(10,2) DEFAULT 0,
    booking_rate            DECIMAL(5,4) DEFAULT 0,
    avg_call_duration_sec   INTEGER      DEFAULT 0,

    -- Thompson Sampling parameters
    alpha                   DECIMAL(10,2) DEFAULT 1.0,
    beta                    DECIMAL(10,2) DEFAULT 1.0,

    -- Metadata
    created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 009: agent_jobs
-- Companion table to BullMQ for pipeline observability.
-- Valid status: queued | active | completed | failed | dead_letter
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS agent_jobs (
    id                      SERIAL PRIMARY KEY,

    job_id                  VARCHAR(100) UNIQUE NOT NULL,
    queue_name              VARCHAR(50)  NOT NULL,
    pipeline_load_id        INTEGER REFERENCES pipeline_loads(id),

    -- Job state
    status                  VARCHAR(20)  NOT NULL DEFAULT 'queued',
    priority                INTEGER      DEFAULT 0,
    attempts                INTEGER      DEFAULT 0,
    max_attempts            INTEGER      DEFAULT 3,

    -- Timing
    queued_at               TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    started_at              TIMESTAMP,
    completed_at            TIMESTAMP,
    failed_at               TIMESTAMP,

    -- Result
    result                  JSONB,
    error_message           TEXT,

    -- Metadata
    created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for agent_jobs
CREATE INDEX IF NOT EXISTS idx_agent_jobs_queue
    ON agent_jobs(queue_name, status);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_pipeline
    ON agent_jobs(pipeline_load_id);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_status
    ON agent_jobs(status);

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 010: ALTER loads (existing table)
-- Link TMS loads back to pipeline loads.
--   source_type:  manual | ai_agent | load_board_import
--   booked_via:   human  | ai_auto  | ai_escalated
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'loads' AND column_name = 'pipeline_load_id'
    ) THEN
        ALTER TABLE loads ADD COLUMN pipeline_load_id INTEGER;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'loads' AND column_name = 'source_type'
    ) THEN
        ALTER TABLE loads ADD COLUMN source_type VARCHAR(20) DEFAULT 'manual';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'loads' AND column_name = 'booked_via'
    ) THEN
        ALTER TABLE loads ADD COLUMN booked_via VARCHAR(20) DEFAULT 'human';
    END IF;
END $$;

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 011: ALTER carriers (existing table)
-- Agent pipeline compatibility columns.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'carriers' AND column_name = 'accepts_ai_dispatch'
    ) THEN
        ALTER TABLE carriers ADD COLUMN accepts_ai_dispatch BOOLEAN DEFAULT true;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'carriers' AND column_name = 'preferred_contact_method'
    ) THEN
        ALTER TABLE carriers ADD COLUMN preferred_contact_method VARCHAR(20) DEFAULT 'phone';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'carriers' AND column_name = 'ai_call_count'
    ) THEN
        ALTER TABLE carriers ADD COLUMN ai_call_count INTEGER DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'carriers' AND column_name = 'ai_acceptance_rate'
    ) THEN
        ALTER TABLE carriers ADD COLUMN ai_acceptance_rate DECIMAL(5,4);
    END IF;
END $$;

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 012: ALTER shippers (existing table)
-- Consent + fatigue tracking columns.
-- shipper_fatigue_score: Increments when calls are declined. Resets after
-- successful booking. If score > 2, wait 7 days before retry.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shippers' AND column_name = 'consent_status'
    ) THEN
        ALTER TABLE shippers ADD COLUMN consent_status VARCHAR(20);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shippers' AND column_name = 'preferred_language'
    ) THEN
        ALTER TABLE shippers ADD COLUMN preferred_language VARCHAR(10) DEFAULT 'en';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shippers' AND column_name = 'ai_interaction_count'
    ) THEN
        ALTER TABLE shippers ADD COLUMN ai_interaction_count INTEGER DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shippers' AND column_name = 'last_ai_call_at'
    ) THEN
        ALTER TABLE shippers ADD COLUMN last_ai_call_at TIMESTAMP;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shippers' AND column_name = 'shipper_fatigue_score'
    ) THEN
        ALTER TABLE shippers ADD COLUMN shipper_fatigue_score INTEGER DEFAULT 0;
    END IF;
END $$;

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- MIGRATION 013: SEED personas
-- 3 default personas for the voice agent pipeline.
-- Uses ON CONFLICT to make this idempotent.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO personas (persona_name, description, tone, prompt_template, is_active, alpha, beta)
VALUES
    (
        'assertive',
        'Direct, confident, time-efficient. Gets to the rate quickly.',
        'direct',
        'You are an assertive freight broker negotiating on behalf of Myra Logistics. Be direct, confident, and time-efficient. Lead with the rate, establish urgency, and close decisively. Do not waste time on small talk unless the shipper initiates it.',
        true,
        1.0,
        1.0
    ),
    (
        'friendly',
        'Warm, personable, conversational. Builds rapport first.',
        'warm',
        'You are a friendly freight broker negotiating on behalf of Myra Logistics. Be warm, personable, and conversational. Build rapport before discussing rates. Show genuine interest in their business. Use the shipper''s name frequently and mirror their communication style.',
        true,
        1.0,
        1.0
    ),
    (
        'analytical',
        'Precise, data-driven, methodical. Leads with market data.',
        'precise',
        'You are an analytical freight broker negotiating on behalf of Myra Logistics. Be precise, data-driven, and methodical. Lead with market data, lane statistics, and rate trends. Present your offer as the logical conclusion of the data. Reference specific numbers and comparisons.',
        true,
        1.0,
        1.0
    )
ON CONFLICT (persona_name) DO NOTHING;

COMMIT;


-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Tables created:  9 (pipeline_loads, agent_calls, negotiation_briefs,
--                     consent_log, dnc_list, shipper_preferences,
--                     lane_stats, personas, agent_jobs)
-- Tables altered:  3 (loads, carriers, shippers)
-- Indexes:         22
-- Seed rows:       3 (personas)
--
-- Next steps:
--   1. Verify with: SELECT table_name FROM information_schema.tables
--      WHERE table_schema = 'public' ORDER BY table_name;
--   2. Confirm new columns on loads/carriers/shippers
--   3. Confirm personas seeded: SELECT * FROM personas;
-- ============================================================================
