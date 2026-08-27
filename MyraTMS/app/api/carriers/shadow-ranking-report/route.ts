import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const since = req.nextUrl.searchParams.get('since');
  const sinceDate = since ? new Date(since) : new Date(0);
  if (Number.isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: 'Invalid since date' }, { status: 400 });
  }

  try {
    const r = await db.query<{ payload: { changed: boolean } }>(
      `SELECT payload FROM events WHERE event_type = 'ranking.shadow_compared' AND occurred_at >= $1`,
      [sinceDate.toISOString()],
    );
    const compared = r.rows.length;
    const changed = r.rows.filter((row) => row.payload?.changed === true).length;
    return NextResponse.json({
      since: sinceDate.toISOString(),
      loadsCompared: compared,
      topPickChanged: changed,
      changeRate: compared > 0 ? changed / compared : 0,
      records: r.rows.map((row) => row.payload),
    });
  } catch (err) {
    logger.error('[carriers/shadow-ranking-report GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load shadow ranking report' }, { status: 500 });
  }
}
