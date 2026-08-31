import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { db } from '@/lib/pipeline/db-adapter';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { id: rawId } = await params;
  const tenantId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return apiError('Invalid tenant id', 400);

  const { rows } = await db.query(
    `SELECT id, current_step, status, started_at, completed_at
       FROM tenant_onboarding_sessions
      WHERE tenant_id = $1
      ORDER BY id DESC LIMIT 1`,
    [tenantId],
  );
  if (rows.length === 0) return apiError('No onboarding session found for this tenant', 404);
  return NextResponse.json(rows[0]);
}
