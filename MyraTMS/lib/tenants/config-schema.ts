// =============================================================================
// Per-key Zod validators for tenant_config values.
//
// Spec: docs/architecture/TENANT_CONFIG_SEMANTICS.md §7
//
// Used by:
//   - Onboarding wizard (Phase 3.2) — validates each step's input before commit
//   - PATCH /api/admin/config/[key] — rejects malformed updates
//   - scripts/sync_tenant_defaults.ts — reuses to validate seeded defaults
//
// Every key in lib/tenants/defaults.ts and lib/tenants/defaults.ts SENSITIVE_CONFIG_KEYS
// MUST have an entry here. The setRequiredKeysCovered guard at module load
// surfaces missing entries during boot rather than at first PATCH call.
// =============================================================================

import { z } from "zod"
import { DEFAULT_TENANT_CONFIG, SENSITIVE_CONFIG_KEYS } from "./defaults"

/**
 * IANA timezone — accepted at the schema level as "anything that round-trips
 * through Intl.DateTimeFormat". Final runtime resolution happens in the
 * frontend's date formatter; we just block obvious garbage here.
 */
const ianaTimezone = z.string().min(3).max(60).refine(
  (val) => {
    try {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat("en-US", { timeZone: val })
      return true
    } catch {
      return false
    }
  },
  { message: "Invalid IANA timezone (e.g. America/Toronto)" },
)

/** Encrypted credentials are stored as opaque strings — schema enforces non-empty only. */
const opaqueCredential = z.string().min(1).max(8192)

export const TENANT_CONFIG_VALIDATORS: Record<string, z.ZodTypeAny> = {
  // --- Localization ---
  currency_default: z.enum(["CAD", "USD", "EUR", "GBP"]),
  locale_default: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, {
    message: "Locale must be BCP 47 form like en-CA",
  }),
  timezone_default: ianaTimezone,
  language_default: z.enum(["en", "fr", "es"]),

  // --- Operational defaults ---
  margin_floor_cad: z.number().min(0).max(10_000),
  margin_floor_usd: z.number().min(0).max(10_000),
  walk_away_rate_factor: z.number().min(0.5).max(1.0),
  checkcall_threshold_hours: z.number().int().min(1).max(72),
  detention_threshold_minutes: z.number().int().min(15).max(720),

  // --- Engine 2 / AutoBroker ---
  persona_alpha_init: z.number().min(0.1).max(100),
  persona_beta_init: z.number().min(0.1).max(100),
  auto_book_profit_threshold_cad: z.number().min(0).max(100_000),
  shipper_fatigue_max: z.number().int().min(0).max(20),

  // --- Branding ---
  branding_logo_url: z.string().url().nullable(),
  branding_primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, {
    message: "Primary color must be a #RRGGBB hex string",
  }),
  branding_company_name: z.string().min(1).max(120).nullable(),

  // --- Communication ---
  smtp_from_email: z.string().email(),
  factoring_email: z.string().email().nullable(),

  // --- Notification preferences ---
  notif_checkcall_enabled: z.boolean(),
  notif_invoice_overdue_days: z.number().int().min(1).max(180),

  // --- Encrypted credentials (sensitive). Schema is opaque-string; the
  //     handler encrypts before storage. ---
  retell_api_key: opaqueCredential,
  retell_agent_id_en: opaqueCredential,
  retell_agent_id_fr: opaqueCredential,
  dat_credentials: opaqueCredential,
  truckstop_credentials: opaqueCredential,
  loadboard_123_credentials: opaqueCredential,
  loadlink_credentials: opaqueCredential,
  stripe_account_id: opaqueCredential,
  persona_api_key: opaqueCredential,
  fmcsa_api_key: opaqueCredential,
  samsara_api_token: opaqueCredential,
  motive_api_token: opaqueCredential,
  twilio_account_sid: opaqueCredential,
  twilio_auth_token: opaqueCredential,
  twilio_from_number: z
    .string()
    .regex(/^\+\d{8,15}$/, { message: "Twilio FROM must be E.164 (+15555555555)" }),
  custom_smtp_host: z.string().min(1).max(255),
  custom_smtp_user: z.string().min(1).max(255),
  custom_smtp_pass: opaqueCredential,
}

/**
 * Module-load guard: every key in DEFAULT_TENANT_CONFIG and SENSITIVE_CONFIG_KEYS
 * must have a validator. Throws at boot if a new default key was added without
 * a corresponding schema entry — fails fast rather than silently accepting any
 * value when that key is PATCHed.
 */
function setRequiredKeysCovered(): void {
  const missing: string[] = []
  for (const def of DEFAULT_TENANT_CONFIG) {
    if (!(def.key in TENANT_CONFIG_VALIDATORS)) missing.push(def.key)
  }
  for (const key of SENSITIVE_CONFIG_KEYS) {
    if (!(key in TENANT_CONFIG_VALIDATORS)) missing.push(key)
  }
  if (missing.length > 0) {
    throw new Error(
      `[tenants/config-schema] Missing Zod validator for keys: ${missing.join(", ")}. ` +
        `Add to TENANT_CONFIG_VALIDATORS or remove from defaults/sensitive lists.`,
    )
  }
}
setRequiredKeysCovered()

/**
 * Validate a single key/value pair. Returns parsed value on success;
 * throws ZodError on failure. Callers that want a Result-shape can wrap.
 */
export function validateConfigValue<T = unknown>(key: string, value: unknown): T {
  const schema = TENANT_CONFIG_VALIDATORS[key]
  if (!schema) {
    throw new Error(`[tenants/config-schema] Unknown config key: ${key}`)
  }
  return schema.parse(value) as T
}

/**
 * Returns true if the key is recognized — used by the admin API to fast-fail
 * 404 on unknown keys before even hitting the DB.
 */
export function isKnownConfigKey(key: string): boolean {
  return key in TENANT_CONFIG_VALIDATORS
}

/**
 * Returns true if the key is one of SENSITIVE_CONFIG_KEYS — used to decide
 * whether the value must be encrypted before storage and masked on reads.
 */
export function isEncryptedConfigKey(key: string): boolean {
  return (SENSITIVE_CONFIG_KEYS as ReadonlyArray<string>).includes(key)
}
