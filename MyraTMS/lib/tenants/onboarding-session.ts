import { db } from '@/lib/pipeline/db-adapter';
import { createTenantRow } from './provision';

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
  return rows[0];
}

export async function provisionTenantFromSession(sessionId: number): Promise<{ tenantId: number }> {
  const { rows } = await db.query<{ step_data: Record<string, any> }>(
    `SELECT step_data FROM tenant_onboarding_sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
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

