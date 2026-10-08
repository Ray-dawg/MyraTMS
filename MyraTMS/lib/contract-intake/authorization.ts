//
// T-30 §3.2 — authorization is checked BEFORE any parsing, and is a
// separate question from T-26's document-to-load matching. An email from
// an address not on this whitelist is never parsed for injection purposes.
//
// This lookup is deliberately GLOBAL (no tenant filter) and cannot be
// otherwise: the mailbox is a single shared inbox, so an inbound email
// carries no tenant context at all — the sender's address IS the tenant
// discriminator. What makes that safe is migration 059's
// uq_contract_shipper_auth_active_email, which enforces one ACTIVE
// authorization per email address and so guarantees at most one tenant can
// claim a sender. Should that invariant ever be violated anyway (an index
// dropped, or a branch where 059 predates the index), this function fails
// CLOSED rather than guessing: a guessed tenant would silently decide tenant
// attribution, which margin floor applies, and which tenant receives the
// pipeline_loads row. Returning null instead routes the email to the
// unauthorized-sender manual-review exception, which is strictly safer.
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

export interface ContractShipperAuthorization {
  id: number;
  tenantId: number;
  shipperEmail: string;
  marginFloorOverrideAmount: number | null;
}

/**
 * More than one tenant holds an active authorization for the sender. Reported
 * distinctly from "not on any whitelist" so the operator-facing exception can
 * name the real cause: telling them the address is on no whitelist when it is
 * on two sends them after the wrong problem, and the only other record of it
 * would be a logger.warn buried in worker logs.
 */
export interface AmbiguousSenderAuthorization {
  ambiguous: true;
  tenantIds: number[];
  authorizationIds: number[];
}

/**
 * `null` keeps meaning "not authorized" so existing truthiness checks at call
 * sites stay correct; an ambiguous sender is a distinct object rather than a
 * fourth falsy value, and `isAmbiguousSender()` is the only way to read it.
 */
export type SenderAuthorizationResult =
  | ContractShipperAuthorization
  | AmbiguousSenderAuthorization
  | null;

export function isAmbiguousSender(
  result: SenderAuthorizationResult,
): result is AmbiguousSenderAuthorization {
  return result !== null && 'ambiguous' in result;
}

export async function checkSenderAuthorization(fromAddress: string): Promise<SenderAuthorizationResult> {
  const email = fromAddress.toLowerCase();
  const { rows } = await db.query<{
    id: number;
    tenant_id: number;
    shipper_email: string;
    margin_floor_override_amount: string | null;
  }>(
    // lower(shipper_email) matches the unique index above, so a row stored
    // mixed-case by direct SQL is still found rather than being
    // unique-blocked yet unreadable.
    `SELECT id, tenant_id, shipper_email, margin_floor_override_amount
       FROM contract_shipper_authorizations
      WHERE lower(shipper_email) = $1 AND is_active = true`,
    [email],
  );

  if (rows.length === 0) return null;

  if (rows.length > 1) {
    const tenantIds = rows.map((r) => Number(r.tenant_id));
    const authorizationIds = rows.map((r) => Number(r.id));
    logger.warn('[contract-intake/authorization] ambiguous sender — more than one tenant holds an active authorization; failing closed', {
      fromAddress: email,
      tenantIds,
      authorizationIds,
    });
    // Fails closed exactly as before — no authorization is returned — but the
    // caller can now say WHY.
    return { ambiguous: true, tenantIds, authorizationIds };
  }

  const row = rows[0];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    shipperEmail: row.shipper_email,
    marginFloorOverrideAmount: row.margin_floor_override_amount !== null ? Number(row.margin_floor_override_amount) : null,
  };
}
