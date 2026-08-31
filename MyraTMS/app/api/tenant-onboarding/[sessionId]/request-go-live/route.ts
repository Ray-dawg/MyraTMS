import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { requestGoLive } from '@/lib/tenants/onboarding-session';

export async function POST(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { sessionId: rawId } = await params;
  const sessionId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return apiError('Invalid session id', 400);

  try {
    const result = await requestGoLive(sessionId);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'Go-live request failed', 400);
  }
}
