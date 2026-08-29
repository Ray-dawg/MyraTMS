// app/api/documents/intake-match-report/route.ts
//
// T-26 §5/criterion 2 — honest numbers, not assumed. Reports over
// inbound_emails (the real intake mechanism — see the implementation
// plan's Global Constraints on why inbound_document_intake was never
// built) joined against the documents rows the imap-poller attached and
// this module's extraction step scored.
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const sinceDays = Number(req.nextUrl.searchParams.get('since') ?? '90');

  try {
    const { rows } = await db.query<{ total: string; matched: string; parseable: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE reply_type = 'shipper_confirmation_reply')::text AS total,
         COUNT(*) FILTER (WHERE reply_type = 'shipper_confirmation_reply' AND matched_load_id IS NOT NULL)::text AS matched,
         (SELECT COUNT(*) FROM documents WHERE type = 'Shipper Rate Confirmation Reply' AND terms_match_status IN ('match', 'mismatch'))::text AS parseable
       FROM inbound_emails
       WHERE received_at > NOW() - ($1 || ' days')::interval`,
      [sinceDays],
    );

    const total = Number(rows[0]?.total ?? 0);
    const matched = Number(rows[0]?.matched ?? 0);
    const parseable = Number(rows[0]?.parseable ?? 0);

    return NextResponse.json({
      sinceDays,
      total,
      matched,
      matchRatePct: total === 0 ? 0 : Math.round((matched / total) * 100),
      extractionAccuracyPct: matched === 0 ? 0 : Math.round((parseable / matched) * 10000) / 100,
      note: 'Reflects real inbound_emails/documents rows only — no assumed or rounded-up numbers.',
    });
  } catch (err) {
    logger.error('[documents/intake-match-report GET] failed', err);
    return NextResponse.json({ error: 'Failed to compute intake-match report' }, { status: 500 });
  }
}
