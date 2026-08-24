import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId, resolveWindowDays } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface FunnelRow {
  calls_initiated: number;
  calls_connected: number;
  calls_booked: number;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const windowDays = resolveWindowDays(searchParams.get('window'));

  try {
    const r = await db.query<FunnelRow>(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'call.initiated') AS calls_initiated,
         COUNT(*) FILTER (WHERE event_type = 'call.connected') AS calls_connected,
         COUNT(*) FILTER (WHERE event_type = 'call.outcome_recorded' AND payload->>'outcome' = 'booked') AS calls_booked
       FROM events
       WHERE tenant_id = $1 AND occurred_at > NOW() - ($2 || ' days')::interval`,
      [tenantId, windowDays],
    );
    return NextResponse.json({ tenant_id: tenantId, window_days: windowDays, ...r.rows[0] });
  } catch (err) {
    logger.error('[metrics/funnel GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load funnel metrics' }, { status: 500 });
  }
}
