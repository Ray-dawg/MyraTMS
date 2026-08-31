import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { startSession } from '@/lib/tenants/onboarding-session';

export async function POST(req: NextRequest) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { sessionId } = await startSession();
  return NextResponse.json({ sessionId }, { status: 201 });
}
