/**
 * Applies scripts/046-e2-04-sellside-loop-schema.sql against live Neon.
 * Split into individual statements — @neondatabase/serverless's .query()
 * rejects multi-statement text ("cannot insert multiple commands into a
 * prepared statement"), confirmed against this same DB in migration 043.
 * Usage: pnpm tsx --env-file=.env.local scripts/apply-046-e2-04-sellside-loop-schema.ts
 */

import { neon } from '@neondatabase/serverless';

const STATEMENTS = [
  `ALTER TABLE pipeline_loads
     ADD COLUMN IF NOT EXISTS shipper_email                    VARCHAR(255),
     ADD COLUMN IF NOT EXISTS confirmation_token                VARCHAR(64),
     ADD COLUMN IF NOT EXISTS confirmation_token_expires_at     TIMESTAMP,
     ADD COLUMN IF NOT EXISTS confirmation_sent_at               TIMESTAMP,
     ADD COLUMN IF NOT EXISTS confirmation_nudged_at             TIMESTAMP,
     ADD COLUMN IF NOT EXISTS confirmed_at                       TIMESTAMP,
     ADD COLUMN IF NOT EXISTS confirmed_rate                     DECIMAL(10,2),
     ADD COLUMN IF NOT EXISTS confirmed_rate_currency            VARCHAR(3),
     ADD COLUMN IF NOT EXISTS confirmation_snapshot              JSONB,
     ADD COLUMN IF NOT EXISTS confirmation_outcome               VARCHAR(20),
     ADD COLUMN IF NOT EXISTS decline_reason                     TEXT,
     ADD COLUMN IF NOT EXISTS shipper_ratecon_returned_at        TIMESTAMP,
     ADD COLUMN IF NOT EXISTS carrier_ratecon_signed_at          TIMESTAMP`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_confirmation_token
     ON pipeline_loads(confirmation_token) WHERE confirmation_token IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS inbound_emails (
      id                 SERIAL PRIMARY KEY,
      message_id         VARCHAR(255) NOT NULL UNIQUE,
      from_address       VARCHAR(255) NOT NULL,
      subject            TEXT,
      body_text          TEXT,
      received_at        TIMESTAMP NOT NULL,
      matched_load_id    INTEGER REFERENCES pipeline_loads(id),
      match_method       VARCHAR(30),
      sender_verified    BOOLEAN NOT NULL DEFAULT false,
      verification_note  TEXT,
      reply_type         VARCHAR(30),
      attachment_count   INTEGER DEFAULT 0,
      processed_at       TIMESTAMP,
      quarantined        BOOLEAN NOT NULL DEFAULT false,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE INDEX IF NOT EXISTS idx_inbound_emails_load ON inbound_emails(matched_load_id, received_at DESC)`,

  `ALTER TABLE personas
     ADD COLUMN IF NOT EXISTS call_type VARCHAR(30) NOT NULL DEFAULT 'outbound_shipper'`,

  `INSERT INTO personas (persona_name, retell_agent_id_en, description, tone, prompt_template, is_active, call_type, alpha, beta)
   SELECT * FROM (VALUES
     ('carrier_direct', 'PENDING_RETELL_AGENT_ID', 'Direct, efficient carrier-facing negotiator. Leads with the load and rate.', 'direct',
      'You are a freight broker dispatcher negotiating with a carrier on behalf of Myra Logistics to secure this load. Be direct and efficient. Lead with lane, equipment, and rate. Close decisively within the negotiation envelope.',
      false, 'outbound_carrier', 1.00, 1.00),
     ('carrier_relationship', 'PENDING_RETELL_AGENT_ID', 'Relationship-driven carrier-facing negotiator. References carrier history.', 'warm',
      'You are a freight broker dispatcher negotiating with a carrier on behalf of Myra Logistics to secure this load. Reference the carrier''s history with Myra where available. Build rapport, then present the load and rate.',
      false, 'outbound_carrier', 1.00, 1.00),
     ('carrier_data_driven', 'PENDING_RETELL_AGENT_ID', 'Data-driven carrier-facing negotiator. Leads with lane stats and market rate.', 'precise',
      'You are a freight broker dispatcher negotiating with a carrier on behalf of Myra Logistics to secure this load. Lead with lane statistics and market rate data. Present the offer as the data-backed number for this lane.',
      false, 'outbound_carrier', 1.00, 1.00)
   ) AS v(persona_name, retell_agent_id_en, description, tone, prompt_template, is_active, call_type, alpha, beta)
   WHERE NOT EXISTS (SELECT 1 FROM personas WHERE persona_name = v.persona_name)`,
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;

  for (const [i, stmt] of STATEMENTS.entries()) {
    console.log(`\n[${i + 1}/${STATEMENTS.length}] Running...`);
    await sqlClient.query(stmt);
    console.log(`[${i + 1}/${STATEMENTS.length}] OK`);
  }

  console.log('\n✅ Migration 046 applied.');
}

main().catch((err) => { console.error('Migration 046 failed:', err); process.exit(1); });
