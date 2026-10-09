// T-30 §6 — tenant-scoped convenience view over contract_intake exceptions,
// joined to inbound_emails for the parsed detail the generic exceptions list
// doesn't show. exceptions.tenant_id is the real tenant boundary here —
// inbound_emails itself has no tenant_id (single shared mailbox, the same
// reality T-19/T-25/T-27 already document). RLS is OFF in production, so the
// explicit `e.tenant_id = $1` predicate is the boundary, not withTenant()'s
// GUC.
//
// Two deliberate departures from the plan text:
//   * status IN ('active','acknowledged') — an operator who merely
//     acknowledges a tender in the Alert Center must not make it vanish from
//     this list while inbound_emails.intake_status is still 'pending_review'.
//     Only resolving it (approve/reject, Task 9) retires it from here.
//   * LEFT JOIN, not JOIN — an inner join would hide forever any
//     contract_intake exception whose inbound_email_id is null, which is the
//     worst possible failure mode for a list whose whole job is visibility.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, requireTenantContext } from '@/lib/auth';
import { withTenant } from '@/lib/db/tenant-context';

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const ctx = requireTenantContext(req);
    // A token carrying no usable tenant claim must not reach withTenant(),
    // whose own guard throws and would surface as a generic 500.
    if (!Number.isInteger(ctx.tenantId) || ctx.tenantId <= 0) {
      return NextResponse.json({ error: 'Forbidden — no tenant context' }, { status: 403 });
    }
    const pending = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT e.id, e.type, e.severity, e.title, e.detail, e.status,
                e.suggested_action, e.sla_due_at, e.created_at,
                e.inbound_email_id,
                ie.from_address, ie.subject, ie.received_at,
                ie.intake_type, ie.intake_status, ie.sender_authorized,
                ie.created_pipeline_load_id
           FROM exceptions e
           LEFT JOIN inbound_emails ie ON ie.id = e.inbound_email_id
          WHERE e.tenant_id = $1
            AND e.source_module = 'contract_intake'
            AND e.status IN ('active', 'acknowledged')
          ORDER BY e.created_at DESC
          LIMIT 500`,
        [ctx.tenantId],
      );
      return rows;
    });
    return NextResponse.json({ pending });
  } catch (err) {
    console.error('[GET /api/contract-intake/pending] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
