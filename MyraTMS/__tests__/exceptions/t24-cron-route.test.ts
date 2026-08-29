// __tests__/exceptions/t24-cron-route.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/exceptions/bridge', () => ({ runExceptionBridge: vi.fn(async () => ({ found: 3, written: 2 })) }));

import { GET } from '@/app/api/cron/exception-bridge/route';

describe('GET /api/cron/exception-bridge', () => {
  it('rejects a request without the correct CRON_SECRET', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const req = new NextRequest('http://x/api/cron/exception-bridge');
    const res = await GET(req);
    expect(res.status).toBe(401);
    process.env.CRON_SECRET = prev;
  });

  it('runs the bridge and returns its totals when authorized', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const req = new NextRequest('http://x/api/cron/exception-bridge', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body).toEqual({ ok: true, found: 3, written: 2 });
    process.env.CRON_SECRET = prev;
  });
});
