/**
 * Retell webhook receiver.
 *
 * Retell POSTs here when a call ends. The actual processing — signature
 * verification, transcript parsing via Claude, persistence to agent_calls,
 * pipeline_loads stage transitions, queue routing — lives in the prebuilt
 * `handleRetellWebhook` function in lib/pipeline/retell-webhook.ts. This
 * route is a thin Next.js wrapper that adapts NextRequest to the shape that
 * function expects and translates its WebhookResponse back into a NextResponse.
 *
 * NOTE on auth: HMAC signature verification is enforced inside
 * handleRetellWebhook using `RETELL_WEBHOOK_SECRET`. Configure that env var
 * with the secret from the Retell dashboard before going live.
 *
 * SCOPE OF THAT CLAIM: it covers POST only. This route is listed in
 * middleware.ts SELF_AUTHENTICATING_PATHS, which bypasses user-JWT auth for
 * the whole path -- so the GET reachability probe below is unauthenticated by
 * design. It is safe only because it returns a fixed two-field marker and
 * touches nothing; do not add any request-derived or environment-derived
 * value to its response, and do not add further methods here without their
 * own credential check.
 */

import { NextRequest, NextResponse } from 'next/server';
import { handleRetellWebhook } from '@/lib/pipeline/retell-webhook';
import { logger } from '@/lib/logger';

// Retell calls this route with arbitrary timing — never cache, always run on the
// Node runtime since the prebuilt handler uses `crypto`, BullMQ, and the Neon
// driver, none of which run on Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    const rawBody = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    const adapted = {
      headers,
      // Signature verification needs the EXACT raw bytes Retell signed — never a
      // re-serialized parse. Expose text() (used for verify) and json().
      text: async () => rawBody,
      json: async () => JSON.parse(rawBody),
    };

    const result = await handleRetellWebhook(adapted as any);

    logger.info('[retell-webhook] processed', {
      status: result.status,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    logger.error('[retell-webhook] route crash', err);
    return NextResponse.json(
      { error: 'webhook_crash', processed: false },
      { status: 500 },
    );
  }
}

// Retell occasionally probes endpoints with GET. Returns a fixed marker so we
// can verify reachability from the dashboard. UNAUTHENTICATED (middleware
// bypasses this path; HMAC verification applies to POST only) -- so the body
// must stay a constant and must never echo anything from the request or env.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, route: 'retell-callback' }, { status: 200 });
}
