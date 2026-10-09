// app/api/cron/contract-intake-finalize/route.ts
//
// T-30 — separate cron from exception-bridge (different responsibility:
// this finishes bookings, it doesn't write exceptions). Same auth/kill-switch-
// free pattern as every other cron in this project.
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { finalizeMatchedTenders } from '@/lib/contract-intake/finalize-booking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return auth === `Bearer ${expected}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await finalizeMatchedTenders();
    logger.info(
      `[cron:contract-intake-finalize] finalized=${result.finalized} skipped=${result.skipped}`,
    );
    return NextResponse.json({ ok: true, finalized: result.finalized, skipped: result.skipped });
  } catch (err) {
    logger.error('[cron:contract-intake-finalize] fatal error', err);
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 });
  }
}
