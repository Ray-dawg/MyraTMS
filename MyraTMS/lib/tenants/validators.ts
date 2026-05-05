// =============================================================================
// Tenant slug validation per ADR-002 §Subdomain resolution.
//
// Slug regex: ^[a-z][a-z0-9-]{2,30}$
//   - Leading lowercase letter (no leading digit, no leading hyphen)
//   - Lowercase alphanumerics + hyphens
//   - Length 3–31 (subdomain-safe)
//   - Disallows leading underscore (reserved for the seeded '_system' tenant)
//
// Reserved slugs are rejected even if they match the regex — they're either
// platform-reserved subdomains (app, www, admin, api, myraos) or operationally
// dangerous names (test, dev, staging) that would confuse routing.
// =============================================================================

const SLUG_REGEX = /^[a-z][a-z0-9-]{2,30}$/

/**
 * Subdomains and slug-shaped names that the platform reserves for itself.
 * Real tenant slugs cannot use these.
 *
 * Lowercase only — slug regex prevents uppercase already.
 */
export const RESERVED_TENANT_SLUGS: ReadonlySet<string> = new Set([
  // Platform infrastructure subdomains
  "app",
  "www",
  "admin",
  "api",
  "myraos",
  "myra-os",
  "platform",
  "console",
  "dashboard",

  // Marketing / corporate
  "blog",
  "docs",
  "help",
  "support",
  "status",
  "careers",
  "legal",
  "privacy",
  "terms",

  // Operational environments
  "dev",
  "test",
  "staging",
  "prod",
  "production",
  "qa",
  "preview",
  "demo",

  // Auth / system
  "auth",
  "oauth",
  "sso",
  "login",
  "logout",
  "signup",
  "system",
  "service",
  "internal",

  // Could-be-confused-for-Myra-internal
  "myra",  // The actual Myra tenant uses 'myra' — added here so a SaaS customer
           // can't take this slug. The seed in 027 inserts before validation runs,
           // so the existing Myra tenant is grandfathered.
])

export class InvalidTenantSlugError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidTenantSlugError"
  }
}

/**
 * Returns true if the slug is shaped correctly AND not in the reserved set.
 * Use this BEFORE inserting into tenants.slug.
 *
 * Note: the seeded '_system' slug intentionally does NOT match the regex
 * (leading underscore). It's inserted via privileged seed in 027 and bypasses
 * this validator — the validator is only for user-supplied slugs.
 */
export function isValidTenantSlug(slug: string): boolean {
  if (typeof slug !== "string") return false
  if (!SLUG_REGEX.test(slug)) return false
  if (RESERVED_TENANT_SLUGS.has(slug)) return false
  return true
}

/**
 * Throwing variant. Throws InvalidTenantSlugError with a specific reason
 * suitable for surfacing to the user (no internal details).
 */
export function assertValidTenantSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new InvalidTenantSlugError("Slug is required")
  }
  if (slug.length < 3) {
    throw new InvalidTenantSlugError("Slug must be at least 3 characters")
  }
  if (slug.length > 31) {
    throw new InvalidTenantSlugError("Slug must be at most 31 characters")
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new InvalidTenantSlugError(
      "Slug must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
    )
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    throw new InvalidTenantSlugError(`Slug "${slug}" is reserved`)
  }
}

/**
 * Returns true if the slug is shaped like the system tenant.
 * Used to gate privileged operations that should never operate on the
 * tenant registry's own meta-tenant.
 */
export function isSystemSlug(slug: string): boolean {
  return slug === "_system"
}
