//
// T-30 §3.2 — authorization is checked BEFORE any parsing, and is a
// separate question from T-26's document-to-load matching. An email from
// an address not on this whitelist is never parsed for injection purposes.
import { db } from '@/lib/pipeline/db-adapter';

export interface ContractShipperAuthorization {
  id: number;
  tenantId: number;
  shipperEmail: string;
  marginFloorOverrideAmount: number | null;
}

export async function checkSenderAuthorization(fromAddress: string): Promise<ContractShipperAuthorization | null> {
  const { rows } = await db.query<{
    id: number;
    tenant_id: number;
    shipper_email: string;
    margin_floor_override_amount: string | null;
  }>(
    `SELECT id, tenant_id, shipper_email, margin_floor_override_amount
       FROM contract_shipper_authorizations
      WHERE shipper_email = $1 AND is_active = true
      LIMIT 1`,
    [fromAddress.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    shipperEmail: row.shipper_email,
    marginFloorOverrideAmount: row.margin_floor_override_amount !== null ? Number(row.margin_floor_override_amount) : null,
  };
}
