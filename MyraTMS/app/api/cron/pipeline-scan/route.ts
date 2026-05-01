/**
 * Cron: pipeline-scan
 *
 * Trigger Agent 1 (Scanner) on a schedule. The build plan calls for this to
 * fire every minute when load-board scrapers are wired in (DAT/Truckstop).
 * For the CSV-only ingest path that's live in Sprint 4, this route is a
 * heartbeat — it confirms the cron is hooked up and reports kill-switch
 * status. Once T-04A (headless scraper) lands or official APIs are
 * provisioned, this route triggers ScannerService.scanAllSources().
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 * Kill switches: PIPELINE_ENABLED, SCANNER_ENABLED
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

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

  const pipelineEnabled = process.env.PIPELINE_ENABLED === 'true';
  const scannerEnabled = process.env.SCANNER_ENABLED === 'true';

  if (!pipelineEnabled || !scannerEnabled) {
    logger.debug('[cron:pipeline-scan] disabled', { pipelineEnabled, scannerEnabled });
    return NextResponse.json({
      ok: true,
      skipped: true,
      pipelineEnabled,
      scannerEnabled,
    });
  }

  // Once load-board scraper integration lands (T-04A or API onboarding),
  // call ScannerService.scanAllSources() here. Until then this is a noop
  // heartbeat — CSV ingest goes through POST /api/pipeline/import.
  logger.debug('[cron:pipeline-scan] heartbeat (no scrapers wired yet)');

  return NextResponse.json({
    ok: true,
    scanned: 0,
    note: 'no scraper integrations wired — ingest via /api/pipeline/import',
  });
}
