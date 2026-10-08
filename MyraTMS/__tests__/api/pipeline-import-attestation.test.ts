import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/pipeline/import/route';

const TOKEN = process.env.PIPELINE_IMPORT_TOKEN || process.env.CRON_SECRET || 'test-token';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/pipeline/import', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pipeline/import attestation contract', () => {
  const prev = { gate: process.env.SHIPPER_DIRECT_GATE_ENABLED, pipe: process.env.PIPELINE_ENABLED, tok: process.env.PIPELINE_IMPORT_TOKEN };
  beforeEach(() => { process.env.PIPELINE_ENABLED = 'true'; process.env.PIPELINE_IMPORT_TOKEN = TOKEN; });
  afterEach(() => { process.env.SHIPPER_DIRECT_GATE_ENABLED = prev.gate; process.env.PIPELINE_ENABLED = prev.pipe; process.env.PIPELINE_IMPORT_TOKEN = prev.tok; });

  it('returns 400 attestation_required when the gate is on and no attestation is given', async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'true';
    const res = await POST(req({ loads: [{ loadId: 'X' }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('attestation_required');
  });

  it('rejects an attestation value outside yes/no/unknown', async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'true';
    const res = await POST(req({ loads: [{ loadId: 'X' }], shipper_direct_attestation: 'maybe' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_attestation');
  });

  it('does not require attestation when the gate is off', async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'false';
    const res = await POST(req({ loads: [] }));
    expect(res.status).toBe(200);
  });
});
