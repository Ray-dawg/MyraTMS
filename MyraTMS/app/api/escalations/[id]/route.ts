import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['pending', 'approved', 'rejected', 'expired'];
const RESOLVED_STATUSES = ['approved', 'rejected'];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: { status?: string; resolution_note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.status || !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }

  // Computed in JS rather than a SQL CASE WHEN so the $1 placeholder isn't
  // reused across two different clause shapes (plain assignment vs. an IN
  // list) — Neon's serverless driver fails type inference ("inconsistent
  // types deduced for parameter $1") when the same parameter appears in
  // both contexts in one prepared statement.
  const resolvedAt = RESOLVED_STATUSES.includes(body.status) ? new Date() : null;

  try {
    const r = await db.query<{ id: number }>(
      `UPDATE escalations
          SET status = $1, resolution_note = $2, assigned_to = $3,
              resolved_at = COALESCE($4, resolved_at)
        WHERE id = $5
        RETURNING id`,
      [body.status, body.resolution_note ?? null, user.userId, resolvedAt, id],
    );
    if (r.rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    logger.info(`[escalations/:id PATCH] escalation=${id} -> ${body.status} by user=${user.userId} (shadow mode — no live consequence)`);
    return NextResponse.json({ id, status: body.status });
  } catch (err) {
    logger.error('[escalations/:id PATCH] failed', err);
    return NextResponse.json({ error: 'Failed to update escalation' }, { status: 500 });
  }
}
