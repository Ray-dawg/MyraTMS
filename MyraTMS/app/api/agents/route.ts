import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AgentRow {
  id: number;
  agent_key: string;
  display_name: string;
  agent_type: string;
  status: string;
  description: string | null;
}

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  try {
    const r = await db.query<AgentRow>(
      `SELECT id, agent_key, display_name, agent_type, status, description FROM agents ORDER BY id`,
    );
    return NextResponse.json({ agents: r.rows });
  } catch (err) {
    logger.error('[agents GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load agents' }, { status: 500 });
  }
}
