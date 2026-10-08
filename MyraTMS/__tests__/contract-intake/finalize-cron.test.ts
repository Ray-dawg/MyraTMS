// Mirrors __tests__/exceptions/t24-cron-route.test.ts's own pattern.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

describe('GET /api/cron/contract-intake-finalize', () => {
  const prevSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.CRON_SECRET = prevSecret;
    vi.doUnmock('@/lib/contract-intake/finalize-booking');
  });

  it('returns 401 without the correct bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/contract-intake-finalize/route');
    const req = new NextRequest('http://localhost/api/cron/contract-intake-finalize');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with finalized and skipped counts when authorized', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.doMock('@/lib/contract-intake/finalize-booking', () => ({
      finalizeMatchedTenders: vi.fn().mockResolvedValue({ finalized: 0, skipped: 0 }),
    }));
    const { GET } = await import('@/app/api/cron/contract-intake-finalize/route');
    const req = new NextRequest('http://localhost/api/cron/contract-intake-finalize', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, finalized: 0, skipped: 0 });
  });
});
