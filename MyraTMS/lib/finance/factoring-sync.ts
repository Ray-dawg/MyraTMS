// Syncs the NEW factoring_submissions.status into the EXISTING
// invoices.factoring_status field — same field, not a duplicate (T-27
// acceptance criterion 5). Joins pipeline_loads.tms_load_id to
// invoices.load_id. Despite the original Engine 2 spec typing tms_load_id
// as INTEGER, production has it as TEXT (confirmed via
// information_schema.columns) matching loads.id/invoices.load_id — see
// lib/workers/dispatcher-worker.ts's own comments on this column. A
// pipeline load with no dispatched TMS load yet (tms_load_id IS NULL) or
// no invoice yet has nothing to sync — not an error.
//
// Tenant scoping: invoices.tenant_id is BIGINT NOT NULL (migration
// 028_add_tenant_id.sql) and app-layer `WHERE tenant_id = ...` is the only
// live tenant boundary in this codebase — migration 029 creates RLS policies
// but does NOT enable them. Without the tenant predicate below, an ops user
// of any tenant could flip another tenant's invoice factoring_status through
// this path.
import { db } from '@/lib/pipeline/db-adapter';

// Matches invoices.factoring_status's real value set
// ('N/A' | 'Submitted' | 'Approved' | 'Funded', per scripts/001-create-tables.sql).
export type InvoiceFactoringStatus = 'N/A' | 'Submitted' | 'Approved' | 'Funded';

export async function syncInvoiceFactoringStatus(
  pipelineLoadId: number,
  status: InvoiceFactoringStatus,
  tenantId: number,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE invoices
        SET factoring_status = $1
      WHERE load_id = (SELECT tms_load_id FROM pipeline_loads WHERE id = $2)
        AND tenant_id = $3
      RETURNING id`,
    [status, pipelineLoadId, tenantId],
  );
  return rows.length > 0;
}
