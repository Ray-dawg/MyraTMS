/**
 * T-17 read API verification — auth boundary, response shape, and the
 * <500ms acceptance criterion (5) at current data volume.
 */

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { GET as eventsGet } from '@/app/api/events/route';
import { GET as eventByIdGet } from '@/app/api/events/[id]/route';
import { GET as funnelGet } from '@/app/api/metrics/funnel/route';
import { GET as stageConversionGet } from '@/app/api/metrics/stage-conversion/route';
import { GET as timeInStageGet } from '@/app/api/metrics/time-in-stage/route';
import { GET as costPerCallGet } from '@/app/api/metrics/cost-per-call/route';

function tokenFor(role: string): string {
  return createToken({
    userId: 'test-user',
    email: 'test@myra.dev',
    role,
    firstName: 'Test',
    lastName: 'User',
    tenantId: 1,
    tenantIds: [1],
  });
}

function requestWithCookie(path: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token) headers.set('cookie', `auth-token=${token}`);
  return new NextRequest(`http://localhost${path}`, { headers });
}

describe('T-17 read API', () => {
  it('GET /api/events rejects unauthenticated requests with 401', async () => {
    const res = await eventsGet(requestWithCookie('/api/events'));
    expect(res.status).toBe(401);
  });

  it('GET /api/events rejects a role without access with 403', async () => {
    const res = await eventsGet(requestWithCookie('/api/events', tokenFor('driver')));
    expect(res.status).toBe(403);
  });

  it('GET /api/events returns 200 with an events array for an admin', async () => {
    const res = await eventsGet(requestWithCookie('/api/events?limit=5', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /api/events/:id returns 404 for a nonexistent event', async () => {
    const res = await eventByIdGet(requestWithCookie('/api/events/999999999', tokenFor('admin')), {
      params: Promise.resolve({ id: '999999999' }),
    });
    expect(res.status).toBe(404);
  });

  const metricEndpoints: Array<[string, (req: NextRequest) => Promise<Response>]> = [
    ['/api/metrics/funnel', funnelGet],
    ['/api/metrics/stage-conversion', stageConversionGet],
    ['/api/metrics/time-in-stage', timeInStageGet],
    ['/api/metrics/cost-per-call', costPerCallGet],
  ];

  it.each(metricEndpoints)(
    'GET %s responds under 500ms for an admin (acceptance criterion 5)',
    async (path, handler) => {
      const start = Date.now();
      const res = await handler(requestWithCookie(path, tokenFor('admin')));
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(500);
    },
  );
});
