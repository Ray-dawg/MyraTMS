// Syncs the NEW factoring_submissions.status into the EXISTING
// invoices.factoring_status field — same field, not a duplicate (T-27
// acceptance criterion 5). Joins pipeline_loads.tms_load_id to
// invoices.load_id. Despite the original Engine 2 spec typing tms_load_id
// as INTEGER, production has it as TEXT (confirmed via
// information_schema.columns) matching loads.id/invoices.load_id — see
// lib/workers/dispatcher-worker.ts's own comments on this column. A
// pipeline load with no dispatched TMS load yet (tms_load_id IS NULL) or
// no invoice yet has nothing to sync — not an error.
import { db } from '@/lib/pipeline/db-adapter';

export async function syncInvoiceFactoringStatus(pipelineLoadId: number, status: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE invoices
        SET factoring_status = $1
      WHERE load_id = (SELECT tms_load_id FROM pipeline_loads WHERE id = $2)
      RETURNING id`,
    [status, pipelineLoadId],
  );
  return rows.length > 0;
}
