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

// Retell occasionally probes endpoints with GET. Return a small marker so we
// can verify reachability from the dashboard without exposing internals.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, route: 'retell-callback' }, { status: 200 });
}
