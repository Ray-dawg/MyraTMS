import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const registryId = Number(id);
  if (!Number.isInteger(registryId)) {
    return NextResponse.json({ error: 'Invalid registry id' }, { status: 400 });
  }

  try {
    const r = await db.query(
      `SELECT id, mc_number, dot_number, legal_name, authority_status, insurance_status,
              insurance_verified_at, first_seen_at, last_activity_at, created_at
         FROM carrier_registry WHERE id = $1`,
      [registryId],
    );
    if (r.rows.length === 0) {
      return NextResponse.json({ error: 'carrier_registry entry not found' }, { status: 404 });
    }
    return NextResponse.json({ carrier: r.rows[0] });
  } catch (err) {
    logger.error('[carriers/registry/:id GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load carrier_registry entry' }, { status: 500 });
  }
}
