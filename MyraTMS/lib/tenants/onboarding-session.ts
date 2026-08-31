import { db } from '@/lib/pipeline/db-adapter';
import { createTenantRow } from './provision';
import { evaluatePolicy } from '@/lib/governance/evaluate-policy-db';
import { resolveDispatchRouting } from '@/lib/dispatch/routing';
import { quotePricing } from '@/lib/pricing/pricing-engine';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

export type OnboardingStep =
  | 'sign_up' | 'company_created' | 'users_created' | 'billing_captured'
  | 'load_sources_selected' | 'policy_confirmed' | 'agents_configured'
  | 'tested' | 'go_live_requested' | 'live';

export interface SessionRow {
  id: number;
  tenant_id: number | null;
  current_step: OnboardingStep;
  step_data: Record<string, any>;
  status: 'in_progress' | 'completed' | 'abandoned';
}

export async function startSession(): Promise<{ sessionId: number }> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO tenant_onboarding_sessions DEFAULT VALUES RETURNING id`,
  );
  return { sessionId: rows[0].id };
}

export async function advanceSession(
  sessionId: number,
  step: OnboardingStep,
  stepData: Record<string, unknown>,
): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `UPDATE tenant_onboarding_sessions
        SET current_step = $2::text,
            step_data = jsonb_set(step_data, ARRAY[$2::text], $3::jsonb, true)
      WHERE id = $1
      RETURNING id, tenant_id, current_step, step_data, status`,
    [sessionId, step, JSON.stringify(stepData)],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  const row = rows[0];
  // Neon returns this BIGINT column as a JS string at runtime despite the
  // declared `number | null` type above -- same documented quirk as
  // lib/tenants/get-myra-tenant-id.ts, requestGoLive, and runDryRun in this
  // file. SessionRow is exported and consumed by future API routes that
  // serialize it to JSON, where an uncoerced string would ship as a quoted
  // value instead of a number.
  return { ...row, tenant_id: row.tenant_id === null ? null : Number(row.tenant_id) };
}

export async function provisionTenantFromSession(sessionId: number): Promise<{ tenantId: number }> {
  const { rows } = await db.query<{ tenant_id: number | null; step_data: Record<string, any> }>(
    `SELECT tenant_id, step_data FROM tenant_onboarding_sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  // Idempotency guard (final-review finding 3): a repeated company_created
  // PATCH (UI double-submit, back-button) must not provision a second,
  // orphaned tenant and silently repoint the session's tenant_id pointer at
  // it. Neon returns this BIGINT column as a JS string at runtime despite
  // the declared type -- same documented quirk as elsewhere in this file.
  if (rows[0].tenant_id !== null) {
    return { tenantId: Number(rows[0].tenant_id) };
  }
  const companyData = rows[0].step_data.company_created;
  if (!companyData) {
    throw new Error(`provisionTenantFromSession: session ${sessionId} has no 'company_created' step data yet`);
  }
  const { tenantId } = await createTenantRow(db, {
    slug: companyData.slug,
    name: companyData.companyName,
    type: 'saas_customer',
    freightBusinessType: companyData.freightBusinessType ?? null,
    status: 'trial',
  });
  await db.query(`UPDATE tenant_onboarding_sessions SET tenant_id = $1 WHERE id = $2`, [tenantId, sessionId]);
  return { tenantId };
}

/** Synthetic fixtures for the dry-run — never written to pipeline_loads.
 *  Two different shapes because evaluatePolicy's PolicyEvaluationLoad and
 *  quotePricing's PricingQuoteRequest['load'] are genuinely different types,
 *  not the same "load" object reused (verified against both real interfaces). */
function syntheticPolicyLoad() {
  return {
    isDirect: true,
    postingSource: 'onboarding_dry_run',
    originCountry: 'CA',
    destinationCountry: 'CA',
  };
}

function syntheticPricingLoad() {
  return {
    originCity: 'Toronto', originState: 'ON', originCountry: 'CA',
    destinationCity: 'Montreal', destinationState: 'QC', destinationCountry: 'CA',
    equipmentType: 'Dry Van', postedRate: null,
    // Fixed distance so a dry-run never triggers a live Mapbox geocode/directions
    // call (lib/quoting/geo/distance-service.ts) or a distance_cache write. That
    // write path also has a pre-existing bug unrelated to T-28: it inserts a
    // `route_geometry` column that does not exist in any migration script
    // (scripts/020-quoting-engine.sql defines distance_cache without it), so it
    // throws whenever NEXT_PUBLIC_MAPBOX_TOKEN is set. Supplying distanceMiles/
    // distanceKm here short-circuits quotePricing's distance lookup
    // (lib/pricing/pricing-engine.ts's resolveDistance, ~line 63) before it ever
    // reaches that code. Real Toronto->Montreal driving distance, ~336 mi / 541 km.
    distanceMiles: 336, distanceKm: 541,
  };
}

export async function runDryRun(sessionId: number): Promise<{ policyOk: boolean; dispatchMode: string; pricingOk: boolean }> {
  const { rows } = await db.query<{ tenant_id: number | null }>(
    `SELECT tenant_id FROM tenant_onboarding_sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  const tenantIdRaw = rows[0].tenant_id;
  if (tenantIdRaw === null) {
    throw new Error(`runDryRun: session ${sessionId} has no provisioned tenant yet — call provisionTenantFromSession first`);
  }
  // Neon returns this BIGINT column as a JS string at runtime despite the
  // declared `number` type above -- same documented quirk as
  // lib/tenants/get-myra-tenant-id.ts and this file's requestGoLive.
  const tenantId = Number(tenantIdRaw);

  const policyResult = await evaluatePolicy({
    tenantId,
    load: syntheticPolicyLoad(),
    correlationId: `t28-dryrun-${sessionId}`,
  });
  const dispatchResult = await resolveDispatchRouting(tenantId);
  const pricingResult = await quotePricing({
    tenantId,
    direction: 'sell',
    requestSource: 'negotiation_api_preview',
    load: syntheticPricingLoad(),
  });

  const summary = {
    policyOk: policyResult.decision === 'accept',
    dispatchMode: dispatchResult.mode,
    pricingOk: pricingResult != null,
  };

  await advanceSession(sessionId, 'tested', summary);

  return summary;
}

/**
 * Bridges a completed onboarding session into T-24's existing exceptions
 * table for human go-live review (design doc §3.2).
 *
 * Before calling bridgeToExceptions, this idempotently ensures a per-tenant
 * exception_classification_rules row exists for source_module=
 * 'tenant_onboarding'. matchClassificationRule() (lib/exceptions/
 * classification-rules.ts) filters by an EXACT tenant_id match, and
 * migration 058 only seeded that row for tenant_id=2 (Myra) — matching
 * T-24/T-25's own precedent of scoping their exception types to Myra.
 * But go_live_requested is the one exception type in this system whose
 * entire purpose is firing for a brand-new, non-Myra tenant. Without its
 * own per-tenant row, matchClassificationRule finds zero rows for any real
 * onboarding customer and bridgeToExceptions silently returns false —
 * reproducing the "silently vanishes" failure mode (design doc finding #5)
 * for every tenant except Myra. This insert (mirroring migration 058's
 * Myra seed row's exact values) closes that gap for every tenant.
 */
export async function requestGoLive(sessionId: number): Promise<{ bridged: boolean }> {
  const { rows } = await db.query<{ tenant_id: number | null; step_data: Record<string, any> }>(
    `SELECT tenant_id, step_data FROM tenant_onboarding_sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  if (rows[0].tenant_id === null) {
    throw new Error(`requestGoLive: session ${sessionId} has no provisioned tenant yet`);
  }
  // Neon returns this BIGINT column as a JS string at runtime despite the
  // declared `number` type above -- same documented quirk as
  // lib/tenants/get-myra-tenant-id.ts. withTenant()'s Number.isInteger()
  // guard (called via bridgeToExceptions below) requires an actual number.
  const tenantId = Number(rows[0].tenant_id);
  const companyName = rows[0].step_data.company_created?.companyName ?? `tenant ${tenantId}`;

  await db.query(
    `INSERT INTO exception_classification_rules (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version)
     VALUES ($1, 'tenant_onboarding', '{}'::jsonb, 'medium', 1440, 'Review onboarding session and approve or reject go-live', 1)
     ON CONFLICT (tenant_id, source_module, version) DO NOTHING`,
    [tenantId],
  );

  const bridged = await bridgeToExceptions({
    tenantId,
    sourceModule: 'tenant_onboarding',
    exceptionType: 'go_live_requested',
    title: `${companyName} has completed onboarding and is requesting go-live`,
    description: `Onboarding session ${sessionId} has completed all steps and is ready for the go-live human review (T-28 spec §3.2).`,
    context: { sessionId },
    pipelineLoadId: null,
    loadId: null,
    carrierId: null,
  });

  await advanceSession(sessionId, 'go_live_requested', { requestedAt: new Date().toISOString() });
  return { bridged };
}
