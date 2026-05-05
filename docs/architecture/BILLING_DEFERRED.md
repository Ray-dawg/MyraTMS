# BILLING_DEFERRED.md

> **Cadence:** Reviewed before the dedicated billing session begins.
> **Last update:** 2026-05-01 (Session 1, Phase 0)
> **Related:** [ADR-003](./ADR-003-feature-gating.md), [STACK_DRIFT_REPORT.md](./STACK_DRIFT_REPORT.md) §4

The multi-tenant retrofit (Sessions 1–8) intentionally **does not implement billing**. This document is the starting point for the future dedicated billing session — what's already in place, what's missing, what order to build it in.

## §1 — What this multi-tenant work DOES include

These billing-adjacent pieces are in scope for Sessions 1–8:

### Schema (Phase 1)

- `tenant_subscriptions` table with:
  - `tier ENUM('starter', 'pro', 'enterprise', 'internal')` — the subscription plan
  - `status ENUM('active', 'trial', 'past_due', 'suspended', 'canceled')` — lifecycle state
  - `started_at`, `expires_at` — date range
  - `feature_overrides JSONB DEFAULT '{}'::jsonb` — per-tenant tier deviations
  - `billing_provider VARCHAR(50)` — NULLABLE, will hold `'stripe'` once integrated
  - `external_subscription_id VARCHAR(200)` — NULLABLE, will hold Stripe subscription ID
  - `external_customer_id VARCHAR(200)` — NULLABLE, will hold Stripe customer ID

### Feature gating (Phase 4)

- `lib/features/index.ts` — feature constants (FEATURES, LIMIT_KEYS) per [ADR-003](./ADR-003-feature-gating.md)
- `lib/features/tiers.ts` — TIER_FEATURES, TIER_LIMITS mapping
- `lib/features/gate.ts` — `requireFeature`, `withinLimit`, `hasFeature` enforcement
- Tier-based access control fully wired across all 90 API routes
- Per-tenant overrides via `feature_overrides` JSONB

### Usage tracking (Phase 4.4)

- `lib/usage/tracker.ts` — write-only counters in Redis (`tenant:{id}:usage:{key}:{period}`)
- Daily aggregation cron writing to a `tenant_usage` table
- Threshold alerts (80%, 100%, 150%, 200%) via in-app notifications + email
- Tenant admin dashboard surface for current usage vs. limit

### Manual subscription assignment (Phase 5.5)

- Super-admin dashboard route to set/change a tenant's `tier` and `feature_overrides`
- All changes logged to `tenant_audit_log` with `event_type = 'subscription_tier_changed'`

### Schema stubs that map to future Stripe state (Phase 1)

```sql
-- Column comments document intended Stripe wiring
COMMENT ON COLUMN tenant_subscriptions.billing_provider IS
  'NULL until billing session: will be ''stripe'' once integrated';
COMMENT ON COLUMN tenant_subscriptions.external_subscription_id IS
  'NULL until billing session: will hold sub_xxx from Stripe';
COMMENT ON COLUMN tenant_subscriptions.external_customer_id IS
  'NULL until billing session: will hold cus_xxx from Stripe';
```

## §2 — What this multi-tenant work does NOT include

The following are explicitly OUT OF SCOPE for Sessions 1–8 and live in the future billing session:

### Stripe SDK integration

- Adding `stripe` npm dep
- `lib/billing/stripe-client.ts` — singleton client with `STRIPE_SECRET_KEY`
- Stripe Customer object creation/sync
- Stripe Product / Price configuration

### Subscription provisioning

- POST `/api/billing/checkout-session` — Stripe Checkout flow for new subs
- POST `/api/billing/portal-session` — Customer Portal for self-serve management
- Trial period handling
- Proration on upgrades / downgrades

### Webhook handling

- POST `/api/webhooks/stripe` — signed webhook handler
- Event handlers: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`
- Webhook secret rotation procedure

### Invoice generation

- Per-tenant monthly invoice generation
- Tax calculation (HST/GST for Canadian tenants, sales tax for US)
- PDF invoice rendering
- Invoice email delivery

### Usage-based billing reconciliation

- Monthly metered-usage report from `tenant_usage` aggregates
- Push usage records to Stripe via `usage_records` API
- Reconciliation against Stripe-side invoice line items

### Subscription lifecycle

- Self-serve upgrade flow
- Self-serve downgrade flow (with feature deprecation grace period)
- Self-serve cancellation flow (with retention prompt)
- End-of-period transitions

### Dunning / failed payment

- Retry schedule on failed payments
- Notification cadence to tenant owner
- Tenant suspension on N consecutive failures
- Recovery flow after payment method update

### Pricing operations

- Promo codes / discounts
- Annual vs. monthly billing toggle
- Usage caps for trial accounts
- Custom enterprise pricing approval workflow

## §3 — Suggested order for the billing session

When Patrice greenlights the dedicated billing session, recommended sequence:

### Phase B1 — Stripe infrastructure (~2h)

1. Add `stripe` dep + create `lib/billing/stripe-client.ts`
2. Configure Stripe Products + Prices for Starter / Pro / Enterprise tiers
3. Configure Stripe Customer Portal preferences
4. Add env vars: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
5. Define `lib/billing/products.ts` mapping internal tier → Stripe Price ID

### Phase B2 — Webhook handler (~2h)

1. POST `/api/webhooks/stripe` — signature verification, idempotent event handling
2. Handle `customer.subscription.*` events → update `tenant_subscriptions` table
3. Handle `invoice.payment_*` events → update `tenant_subscriptions.status`
4. Handle `customer.deleted` → tenant cleanup workflow
5. Test with Stripe CLI `stripe listen --forward-to localhost:3000/api/webhooks/stripe`

### Phase B3 — Customer Portal integration (~1h)

1. POST `/api/billing/portal-session` — generate signed Customer Portal URL
2. UI route in tenant admin dashboard with "Manage Billing" button
3. Verify upgrade / downgrade / cancellation flows update tenant_subscriptions correctly via webhooks

### Phase B4 — Checkout for new tenants (~2h)

1. POST `/api/billing/checkout-session` — generate Checkout URL
2. Onboarding wizard (Phase 3.2) integration: after Step 2 (Subscription), redirect to Stripe Checkout for paid tiers
3. `success_url` and `cancel_url` configuration
4. Trial period handling (e.g., 14 days for Starter, 30 days for Pro)

### Phase B5 — Usage-based billing (~3h)

1. Daily cron aggregating `tenant_usage` → push to Stripe `usage_records`
2. Configure metered Stripe prices for AutoBroker bookings, Retell minutes, Quick Pay advances
3. Reconciliation report (monthly): compare internal usage vs. Stripe-side billed quantity
4. Alert on discrepancies > 1%

### Phase B6 — Dunning (~2h)

1. On `invoice.payment_failed`: notify tenant owner via email + in-app
2. After 3 consecutive failures (Stripe default): auto-suspend tenant (`status = 'suspended'`)
3. Recovery flow: tenant updates payment method, webhook reactivates
4. Grace period: 7 days suspended before purge eligibility (per [SECURITY.md](./SECURITY.md) §1)

### Phase B7 — Admin operations (~1h)

1. Super-admin dashboard: view all tenants' subscription status
2. Manual subscription override (already in place from Phase 5.5)
3. Refund initiation (creates Stripe refund + audit log entry)
4. Promo code application

### Total estimate: ~13 hours

Plus testing, documentation, and Stripe Test Mode → Live Mode transition (~3 additional hours).

## §4 — Pre-conditions before billing session can start

These must be in place before Phase B1 begins:

- [ ] Phase M4 complete (multi-tenant production deployment fully operational)
- [ ] Tenant 2 (Sudbury) operating cleanly for ≥7 days
- [ ] At least one Pro-tier or Enterprise-tier prospect identified — billing has no purpose without a customer
- [ ] Patrice approves Stripe pricing per tier
- [ ] Stripe account configured (Production mode, Canadian + US settlement, applicable tax registration)
- [ ] Tax handling decision made — Stripe Tax enabled, or manual / accountant
- [ ] Legal review of Terms of Service + Subscription Agreement (Patrice's call when to engage)

## §5 — Risks unique to billing implementation

Worth flagging in advance:

1. **Webhook race conditions** — a `subscription.updated` webhook can arrive before the corresponding API call returns. Idempotent event handling required (`idempotency_key` on every Stripe call; webhook handler checks for already-processed events).
2. **Stripe Test → Live cutover** — test mode webhook URL and live mode webhook URL are different. Easy to misconfigure. Use Vercel preview deployments for staging tests, production for live.
3. **Usage-based billing precision** — Stripe rounds usage records to integer units. Retell minutes (decimal) need careful rounding (round-up to nearest minute = customer-friendly).
4. **Tax compliance** — selling SaaS to Canadian customers triggers HST/GST registration once revenue crosses thresholds. Selling to US customers triggers state-specific sales tax obligations. Stripe Tax automates most of this but requires correct customer billing address.
5. **Subscription model vs. metered model** — current ADR-003 describes tier-flat pricing with metered overages. If tier itself becomes metered (e.g., $X per active load), the schema needs more flexibility — flag for revision in B5 if tier model evolves.
6. **Refund accounting** — refunds change the tenant's effective billing position. Audit log + reconciliation must be precise.
7. **Currency** — Stripe Customer is single-currency. A Canadian tenant who switches to USD billing requires a new Stripe Customer. Document the migration path.

## §6 — What "billing in place" means for closing this doc

This doc gets archived (renamed `BILLING_IMPLEMENTED.md`) when:

- [ ] All sections in §3 (B1–B7) are deployed and tested
- [ ] At least one paying tenant (Tenant 3+) has been billed end-to-end (charged, paid, invoice generated)
- [ ] Failure modes (webhook retries, dunning, refunds) tested in production
- [ ] Stripe Test Mode mirror configured for safe development

End of BILLING_DEFERRED.md.
