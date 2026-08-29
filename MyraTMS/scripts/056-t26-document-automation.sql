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
    SELECT COALESCE(
        (SELECT pipeline_load_id FROM loads WHERE id = NEW.related_to),
        (SELECT id FROM pipeline_loads WHERE load_id = NEW.related_to)
    ) INTO v_pipeline_load_id;

    IF v_pipeline_load_id IS NULL THEN
        RETURN NEW;
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
