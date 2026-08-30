// app/api/finance/route-decision/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { decideRoute } from '@/lib/finance/routing';
import type { Route } from '@/lib/finance/routing';
import { getPayerCreditLevel, getCarrierWantsQuickPay } from '@/lib/finance/credit-lookup';
import { getFloatExposure, isFloatCapacityAvailable } from '@/lib/finance/float-governor';
import { computeCapitalDays, computeYieldPer1000CapitalDays } from '@/lib/finance/capital-days';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const pipelineLoadId = Number(body?.pipelineLoadId);
  if (!Number.isInteger(pipelineLoadId)) {
    return NextResponse.json({ error: 'Invalid pipelineLoadId' }, { status: 400 });
  }
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const payerCreditLevel = await getPayerCreditLevel(pipelineLoadId);
    const carrierWantsQuickPay = await getCarrierWantsQuickPay(pipelineLoadId);
    const projectedRow = await db.query<{ agreed_rate: string | null }>(
      `SELECT agreed_rate FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    const projectedAmount = Number(projectedRow.rows[0]?.agreed_rate ?? 0);
    const exposure = await getFloatExposure(tenantId);
    const floatCapacityAvailable = isFloatCapacityAvailable(exposure, projectedAmount);

    const decision = decideRoute({ payerCreditLevel, carrierWantsQuickPay, floatCapacityAvailable });

    // Day-counts per route are given verbatim in the spec's own §1 worked
    // table (T27_Finance_Orchestration.md) — NOT part of the missing Pilot 1
    // document. Only the exact resulting dollar yield is unverified (criteria
    // 1/6, still OPEN). DECLINE has no days-held concept.
    //
    // Keyed on Exclude<Route, 'DECLINE'> rather than `string` so that adding a
    // new member to the Route union is a compile error here instead of a
    // silent `undefined` day-count — which would make computeCapitalDays()
    // return NaN, and Postgres `numeric` accepts the literal NaN without
    // complaint, persisting it straight into financing_decisions.
    const DAYS_HELD_BY_ROUTE: Record<Exclude<Route, 'DECLINE'>, number> = { T1: 10, T2: 39, T3: 1, T4: -29 };
    let capitalDaysProjected: number | null = null;
    let yieldProjected: number | null = null;
    if (decision.route !== 'DECLINE') {
      const marginRow = await db.query<{ profit: string | null }>(
        `SELECT profit FROM pipeline_loads WHERE id = $1`,
        [pipelineLoadId],
      );
      const marginDollars = Number(marginRow.rows[0]?.profit ?? 0);
      const daysHeld = DAYS_HELD_BY_ROUTE[decision.route];
      const capitalDaysResult = computeCapitalDays(projectedAmount, daysHeld);
      capitalDaysProjected = capitalDaysResult.capitalDays;
      yieldProjected = computeYieldPer1000CapitalDays(marginDollars, capitalDaysResult.capitalDays);
    }

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO financing_decisions
         (pipeline_load_id, tenant_id, payer_credit_level_at_decision, carrier_payment_preference,
          float_capacity_available_at_decision, route_selected, capital_days_projected, yield_projected)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [pipelineLoadId, tenantId, payerCreditLevel, carrierWantsQuickPay ? 'quick_pay' : 'net_30', floatCapacityAvailable, decision.route, capitalDaysProjected, yieldProjected],
    );

    return NextResponse.json({ financingDecisionId: rows[0].id, ...decision });
  } catch (err) {
    logger.error('[finance/route-decision POST] failed', err);
    return NextResponse.json({ error: 'Failed to compute route decision' }, { status: 500 });
  }
}
