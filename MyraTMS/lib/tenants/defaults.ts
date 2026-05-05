// =============================================================================
// DEFAULT_TENANT_CONFIG — keys cloned into a new tenant's tenant_config at
// provisioning time. See docs/architecture/TENANT_CONFIG_SEMANTICS.md §2.
//
// IMPORTANT: keep in sync with the seed block in 027_multi_tenant_foundation.sql.
// SQL hardcodes the same defaults for the Myra tenant; this constant is used
// for every NEW tenant provisioned post-Phase-1.
//
// Per ADR-003 / TENANT_CONFIG_SEMANTICS:
//   - encrypted=true keys are NOT in this list. Integration credentials are
//     set per-tenant during onboarding (Phase 3.2 wizard), never defaulted
//     with placeholder values.
//   - Validation per key lives in lib/tenants/config-schema.ts (Phase 3.1).
// =============================================================================

export interface TenantConfigDefault {
  key: string
  /** JSON-encoded value as it will be stored in tenant_config.value (TEXT). */
  value: unknown
  encrypted: boolean
  description: string
}

export const DEFAULT_TENANT_CONFIG: ReadonlyArray<TenantConfigDefault> = [
  // --- Localization ---
  {
    key: "currency_default",
    value: "CAD",
    encrypted: false,
    description:
      "ISO 4217 currency code for amounts displayed in UI and emails",
  },
  {
    key: "locale_default",
    value: "en-CA",
    encrypted: false,
    description: "BCP 47 locale tag — drives date/number formatting",
  },
  {
    key: "timezone_default",
    value: "America/Toronto",
    encrypted: false,
    description:
      "IANA timezone — drives schedule display and check-call windows",
  },
  {
    key: "language_default",
    value: "en",
    encrypted: false,
    description:
      "Primary UI language; secondary requires multi_language feature",
  },

  // --- Operational defaults ---
  {
    key: "margin_floor_cad",
    value: 150,
    encrypted: false,
    description:
      "Minimum margin in CAD; loads under floor get warning, not blocked",
  },
  {
    key: "margin_floor_usd",
    value: 110,
    encrypted: false,
    description: "Minimum margin in USD",
  },
  {
    key: "walk_away_rate_factor",
    value: 0.92,
    encrypted: false,
    description:
      "Carrier rate threshold below which negotiation walks away; 0.92 = 92% of target",
  },
  {
    key: "checkcall_threshold_hours",
    value: 4,
    encrypted: false,
    description: "Hours since last check-call before alert raised",
  },
  {
    key: "detention_threshold_minutes",
    value: 120,
    encrypted: false,
    description: "Minutes at pickup/delivery before detention flag",
  },

  // --- Engine 2 / AutoBroker ---
  {
    key: "persona_alpha_init",
    value: 1.0,
    encrypted: false,
    description:
      "Thompson Sampling Beta α prior — defaults match Engine 2 seed",
  },
  {
    key: "persona_beta_init",
    value: 1.0,
    encrypted: false,
    description: "Thompson Sampling Beta β prior",
  },
  {
    key: "auto_book_profit_threshold_cad",
    value: 200,
    encrypted: false,
    description: "Minimum profit to trigger auto-book (vs. escalate)",
  },
  {
    key: "shipper_fatigue_max",
    value: 2,
    encrypted: false,
    description: "Max declined calls before shipper enters 7-day cooldown",
  },

  // --- Branding (placeholder values; updated at onboarding) ---
  {
    key: "branding_logo_url",
    value: null,
    encrypted: false,
    description: "Tenant logo URL; null = use Myra default",
  },
  {
    key: "branding_primary_color",
    value: "#0066FF",
    encrypted: false,
    description: "Primary brand color hex",
  },
  {
    key: "branding_company_name",
    value: null,
    encrypted: false,
    description:
      "Company name in voice agent script and emails; null = use tenants.name",
  },

  // --- Communication ---
  {
    key: "smtp_from_email",
    value: "noreply@myralogistics.com",
    encrypted: false,
    description:
      "Per-tenant FROM email; whitelabel tenants override during onboarding",
  },
  {
    key: "factoring_email",
    value: null,
    encrypted: false,
    description:
      "Tenant factoring company email; null = factoring disabled",
  },

  // --- Notification preferences ---
  {
    key: "notif_checkcall_enabled",
    value: true,
    encrypted: false,
    description: "Send check-call reminder notifications",
  },
  {
    key: "notif_invoice_overdue_days",
    value: 7,
    encrypted: false,
    description: "Days overdue before invoice alert",
  },
] as const

/**
 * Sensitive keys that are NEVER in DEFAULT_TENANT_CONFIG. Listed here for
 * documentation — they're set during onboarding (Phase 3.2) per tenant.
 * Storing this list lets the admin dashboard render placeholder rows.
 */
export const SENSITIVE_CONFIG_KEYS: ReadonlyArray<string> = [
  "retell_api_key",
  "retell_agent_id_en",
  "retell_agent_id_fr",
  "dat_credentials",
  "truckstop_credentials",
  "loadboard_123_credentials",
  "loadlink_credentials",
  "stripe_account_id",
  "persona_api_key",
  "fmcsa_api_key",
  "samsara_api_token",
  "motive_api_token",
  "twilio_account_sid",
  "twilio_auth_token",
  "twilio_from_number",
  "custom_smtp_host",
  "custom_smtp_user",
  "custom_smtp_pass",
] as const
