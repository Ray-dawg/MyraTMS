/**
 * POST /api/pipeline/loads/[id]/resolve-source — E2-01 §4.7 step 3.
 *
 * A human resolves a load-source review from the Alert Center: the answer is
 * written to poster_registry once, the load goes back to 'scanned', and it is
 * re-queued so the Qualifier resolves it from the registry. Body:
 *   { entity_class: 'shipper'|'broker'|'carrier_for_hire'|'carrier_private',
 *     applies_to_poster?: boolean (default true), note?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { Queue } from 'bullmq';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { resolveLoadSource, type ResolveEntityClass } from '@/lib/pipeline/resolve-load-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENTITY_CLASSES = new Set<ResolveEntityClass>(['shipper', 'broker', 'carrier_for_hire', 'carrier_private']);
let queue: Queue | null = null;
const getQueue = () => (queue ??= new Queue('qualify-queue', { connection: redisConnection }));

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const denied = requireRole(user, 'admin', 'owner', 'service_admin', 'dispatcher');
  if (denied) return denied;

  const { id } = await params;
  const pipelineLoadId = Number(id);
  if (!Number.isInteger(pipelineLoadId)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });

  let body: { entity_class?: string; applies_to_poster?: boolean; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.entity_class || !ENTITY_CLASSES.has(body.entity_class as ResolveEntityClass)) {
    return NextResponse.json({ error: 'invalid_entity_class', allowed: [...ENTITY_CLASSES] }, { status: 400 });
  }

  const result = await resolveLoadSource(
    {
      pipelineLoadId,
      entityClass: body.entity_class as ResolveEntityClass,
      appliesToPoster: body.applies_to_poster !== false,
      note: body.note ?? null,
      resolvedBy: user.userId,
    },
    getQueue(),
  );

  if (result.ok) return NextResponse.json(result);
  return NextResponse.json(result, { status: result.error === 'not_found' ? 404 : 409 });
}
