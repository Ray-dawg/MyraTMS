import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { advanceSession, provisionTenantFromSession, type OnboardingStep } from '@/lib/tenants/onboarding-session';
import { applyTenantTypePolicyTemplate, captureBillingIntent, seatTenantOwner } from '@/lib/tenants/provision';
import { db } from '@/lib/pipeline/db-adapter';

const STEP_VALUES = [
  'sign_up', 'company_created', 'users_created', 'billing_captured',
  'load_sources_selected', 'policy_confirmed', 'agents_configured',
  'tested', 'go_live_requested', 'live',
] as const;

const BODY = z.object({
  step: z.enum(STEP_VALUES),
  stepData: z.record(z.string(), z.unknown()),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;

  const { sessionId: rawId } = await params;
  const sessionId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return apiError('Invalid session id', 400);

  let body: z.infer<typeof BODY>;
  try {
    body = BODY.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(`Invalid body: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }
    return apiError('Invalid JSON body', 400);
  }

  const session = await advanceSession(sessionId, body.step as OnboardingStep, body.stepData);

  let tenantId: number | null = session.tenant_id;

  // Each step that has a real provisioning side effect fires it here,
  // immediately after the session row itself advances (spec §4's flow).
  if (body.step === 'company_created') {
    const result = await provisionTenantFromSession(sessionId);
    tenantId = result.tenantId;
  } else if (body.step === 'users_created') {
    if (tenantId === null) return apiError("Cannot set 'users_created' before 'company_created' has provisioned a tenant", 409);
    const ownerUserId = body.stepData.ownerUserId as string | undefined;
    if (!ownerUserId) return apiError("stepData.ownerUserId is required for the 'users_created' step", 400);
    await seatTenantOwner(db, tenantId, ownerUserId);
  } else if (body.step === 'billing_captured') {
    if (tenantId === null) return apiError("Cannot set 'billing_captured' before 'company_created' has provisioned a tenant", 409);
    const tier = body.stepData.tier as 'starter' | 'pro' | 'enterprise' | undefined;
    if (!tier) return apiError("stepData.tier is required for the 'billing_captured' step", 400);
    await captureBillingIntent(db, tenantId, tier);
  } else if (body.step === 'policy_confirmed') {
    if (tenantId === null) return apiError("Cannot set 'policy_confirmed' before 'company_created' has provisioned a tenant", 409);
    const freightBusinessType = body.stepData.freightBusinessType as 'broker' | 'dispatcher' | 'carrier' | undefined;
    if (!freightBusinessType) return apiError("stepData.freightBusinessType is required for the 'policy_confirmed' step", 400);
    await applyTenantTypePolicyTemplate(db, tenantId, freightBusinessType);
  }

  return NextResponse.json({ sessionId, tenantId, currentStep: session.current_step });
}
