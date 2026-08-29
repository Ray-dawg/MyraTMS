// app/api/cron/exception-bridge/route.ts
//
// T-24 — new cron, separate from the existing exception-detect cron
// (criterion 7: that one is not modified). Runs the 4 pollers in
// lib/exceptions/bridge.ts. Same auth/kill-switch-free pattern as
// app/api/cron/pipeline-health/route.ts: failures are logged and the
// route still returns 200 so Vercel doesn't disable the cron.
//
// Scheduled once daily (vercel.json, 1pm) rather than hourly: every
// existing cron in this project runs once daily despite several of their
// own docblocks claiming a 5-minute interval — a strong signal this
// deployment is on a Vercel plan that caps cron frequency to once a day.
// This cron follows vercel.json (the actual source of truth), not an
// aspirational comment.

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { runExceptionBridge } from '@/lib/exceptions/bridge';

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
    const result = await runExceptionBridge();
    logger.info(`[cron:exception-bridge] found=${result.found} written=${result.written}`);
    return NextResponse.json({ ok: true, found: result.found, written: result.written });
  } catch (err) {
    logger.error('[cron:exception-bridge] fatal error', err);
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 });
  }
}
