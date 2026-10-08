// T-30 §6 — manages the per-tenant sender whitelist that
// lib/contract-intake/authorization.ts reads. Super-admin-only, the same gate
// as the sibling app/api/tenants/[id]/onboarding-status/route.ts —
// authorizing a shipper to originate real bookings is a platform-operator
// action, not a tenant self-service one, in this build.
//
// margin_floor_override_amount is a DOLLAR amount (migration 059, design
// §2.3), not a percentage. NUMERIC comes back from Neon as a string, so
// callers must coerce before arithmetic.
import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { db } from '@/lib/pipeline/db-adapter';

function parseTenantId(rawId: string): number | null {
  const tenantId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  return tenantId;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;

  const { id: rawId } = await params;
  const tenantId = parseTenantId(rawId);
  if (tenantId === null) return apiError('Invalid tenant id', 400);

  try {
    const { rows } = await db.query(
      `SELECT id, tenant_id, shipper_email, shipper_company_name,
              margin_floor_override_amount, is_active, authorized_by, authorized_at
         FROM contract_shipper_authorizations
        WHERE tenant_id = $1
        ORDER BY authorized_at DESC, id DESC`,
      [tenantId],
    );
    return NextResponse.json(rows);
  } catch (err) {
    console.error('[GET /api/tenants/:id/contract-shippers] Error:', err);
    return apiError('Internal server error', 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;

  const { id: rawId } = await params;
  const tenantId = parseTenantId(rawId);
  if (tenantId === null) return apiError('Invalid tenant id', 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const { shipperEmail, shipperCompanyName, marginFloorOverrideAmount, authorizedBy } =
    (body ?? {}) as {
      shipperEmail?: unknown;
      shipperCompanyName?: unknown;
      marginFloorOverrideAmount?: unknown;
      authorizedBy?: unknown;
    };

  if (typeof shipperEmail !== 'string' || shipperEmail.trim() === '' ||
      typeof authorizedBy !== 'string' || authorizedBy.trim() === '') {
    return apiError('shipperEmail and authorizedBy are required', 400);
  }

  // The whitelist is matched against a lowercased sender address, so store it
  // lowercased — otherwise a mixed-case entry here silently never matches.
  const email = shipperEmail.trim().toLowerCase();

  let overrideAmount: number | null = null;
  if (marginFloorOverrideAmount !== undefined && marginFloorOverrideAmount !== null) {
    const amount = Number(marginFloorOverrideAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return apiError('marginFloorOverrideAmount must be a non-negative dollar amount', 400);
    }
    overrideAmount = amount;
  }

  try {
    // UNIQUE (tenant_id, shipper_email) — handled deliberately so a repeat
    // authorization is a 409, never an unhandled unique-violation 500.
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations
         (tenant_id, shipper_email, shipper_company_name, margin_floor_override_amount, authorized_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, shipper_email) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        email,
        typeof shipperCompanyName === 'string' && shipperCompanyName.trim() !== ''
          ? shipperCompanyName.trim()
          : null,
        overrideAmount,
        authorizedBy.trim(),
      ],
    );
    if (rows.length === 0) {
      return apiError(`${email} is already authorized for this tenant`, 409);
    }
    return NextResponse.json({ id: Number(rows[0].id) }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/tenants/:id/contract-shippers] Error:', err);
    return apiError('Internal server error', 500);
  }
}
