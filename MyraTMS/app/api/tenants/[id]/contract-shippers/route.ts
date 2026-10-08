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
import { getCurrentUser, requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { db } from '@/lib/pipeline/db-adapter';

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

/** NUMERIC(10,2) holds at most 8 integer digits plus 2 decimals. */
const MAX_OVERRIDE_AMOUNT = 99999999.99;

/** Bounded so an ORDER BY can never stream an unbounded result set. */
const MAX_ROWS = 500;

function parseTenantId(rawId: string): number | null {
  const tenantId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  return tenantId;
}

/**
 * The margin floor is a safety control, and validate-rate.ts resolves it with
 * NULLISH coalescing (`override ?? tenantFloor`) — so a stored 0 is NOT
 * replaced by the tenant floor, it *replaces* it, and every tender at or above
 * cost then clears forever for that shipper. `Number()` would quietly turn
 * '', '  ', [] and false into exactly that 0 (and true into 1), which an empty
 * form field produces by accident. So: require a real number, strictly
 * positive, inside NUMERIC(10,2)'s range, and with no more than two decimals
 * (the column would otherwise silently round an authorized dollar figure).
 * An intentional "no floor" must be a separate explicit flag, never a blank.
 */
function validateOverrideAmount(raw: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, error: 'marginFloorOverrideAmount must be a number (a dollar amount), not a string or blank' };
  }
  if (raw <= 0) {
    return { ok: false, error: 'marginFloorOverrideAmount must be greater than 0 — a zero floor would disable the margin check entirely' };
  }
  if (raw > MAX_OVERRIDE_AMOUNT) {
    return { ok: false, error: `marginFloorOverrideAmount must not exceed ${MAX_OVERRIDE_AMOUNT}` };
  }
  // Rejects exponent notation (1e-7 would round to 0.00) and >2 decimals.
  if (!/^\d+(\.\d{1,2})?$/.test(String(raw))) {
    return { ok: false, error: 'marginFloorOverrideAmount must have at most 2 decimal places' };
  }
  return { ok: true, value: raw };
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
        ORDER BY authorized_at DESC, id DESC
        LIMIT ${MAX_ROWS}`,
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
  // requireSuperAdmin already proved a valid JWT exists; this re-read is how
  // we get the *verified* identity rather than trusting the request body.
  const user = getCurrentUser(req);
  if (!user) return apiError('Unauthorized', 401);

  const { id: rawId } = await params;
  const tenantId = parseTenantId(rawId);
  if (tenantId === null) return apiError('Invalid tenant id', 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const { shipperEmail, shipperCompanyName, marginFloorOverrideAmount } = (body ?? {}) as {
    shipperEmail?: unknown;
    shipperCompanyName?: unknown;
    marginFloorOverrideAmount?: unknown;
  };

  if (typeof shipperEmail !== 'string' || shipperEmail.trim() === '') {
    return apiError('shipperEmail is required', 400);
  }

  const override = validateOverrideAmount(marginFloorOverrideAmount);
  if (!override.ok) return apiError(override.error, 400);

  // The whitelist is matched against a lowercased sender address, so store it
  // lowercased — otherwise a mixed-case entry here is unique-blocked by
  // migration 059's lower(shipper_email) index yet never read back.
  const email = shipperEmail.trim().toLowerCase();

  // authorized_by is the audit trail for a control that permits real bookings,
  // so it is derived from the verified JWT. A caller-supplied `authorizedBy`
  // is ignored outright: letting a super-admin write any name here (including
  // another operator's) makes the trail worthless. A free-text note would
  // need its own column; that is deferred rather than smuggled in here.
  const authorizedBy = (user.email || user.userId).slice(0, 100);

  try {
    // One shipper email maps to at most one tenant — the invariant migration
    // 059's uq_contract_shipper_auth_active_email enforces and that
    // checkSenderAuthorization()'s deliberately global read depends on.
    // Checked here so the caller gets a 409 that names the holder, instead of
    // a bare unique violation; the catch below still covers the race.
    const conflict = await db.query<{ id: number; tenant_id: string }>(
      `SELECT id, tenant_id
         FROM contract_shipper_authorizations
        WHERE lower(shipper_email) = $1 AND is_active = true AND tenant_id <> $2
        LIMIT 1`,
      [email, tenantId],
    );
    if (conflict.rows.length > 0) {
      return apiError(
        `${email} is already actively authorized for tenant ${conflict.rows[0].tenant_id} — one shipper email maps to at most one tenant`,
        409,
        { conflictingTenantId: Number(conflict.rows[0].tenant_id) },
      );
    }

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
        override.value,
        authorizedBy,
      ],
    );

    if (rows.length === 0) {
      // UNIQUE (tenant_id, shipper_email) swallowed by DO NOTHING. Report the
      // row that actually exists rather than asserting it is authorized — it
      // may have been deactivated out of band, in which case "already
      // authorized" would be the opposite of the truth.
      const existing = await db.query<{ id: number; is_active: boolean }>(
        `SELECT id, is_active FROM contract_shipper_authorizations
          WHERE tenant_id = $1 AND shipper_email = $2`,
        [tenantId, email],
      );
      const row = existing.rows[0];
      const isActive = row?.is_active === true;
      return apiError(
        isActive
          ? `${email} is already authorized for this tenant`
          : `${email} has a deactivated authorization for this tenant — reactivating it is not available on this route`,
        409,
        { id: row ? Number(row.id) : null, isActive },
      );
    }
    return NextResponse.json({ id: Number(rows[0].id) }, { status: 201 });
  } catch (err) {
    if ((err as { code?: string } | null)?.code === PG_UNIQUE_VIOLATION) {
      return apiError(`${email} is already actively authorized for another tenant`, 409);
    }
    console.error('[POST /api/tenants/:id/contract-shippers] Error:', err);
    return apiError('Internal server error', 500);
  }
}
