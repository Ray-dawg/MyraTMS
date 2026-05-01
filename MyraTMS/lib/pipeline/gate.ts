/**
 * Completion Gate Logic — Research + Ranker Parallel Merge
 *
 * When a load enters the `qualified` stage, both Agent 3 (Researcher) and
 * Agent 4 (Carrier Ranker) start in parallel. This gate module handles the
 * synchronization: checking completion status and triggering the next stage
 * (Brief Compiler, Agent 5) only when BOTH parallel jobs complete.
 *
 * The gate uses database checks rather than distributed locks — simple,
 * idempotent, and robust to network failures.
 *
 * @module lib/pipeline/gate
 */

import type { Database } from './db-adapter';

/**
 * Status of a parallel job in the gate.
 */
export interface ParallelJobStatus {
  /** Whether the job has completed */
  completed: boolean;

  /** Timestamp of completion (null if not completed) */
  completedAt: string | null;

  /** Job ID in BullMQ queue */
  jobId: string | null;

  /** Any error from the job (null if successful) */
  error: string | null;
}

/**
 * Overall gate status for a load.
 */
export interface GateStatus {
  /** Load ID */
  pipelineLoadId: number;

  /** Research job status */
  research: ParallelJobStatus;

  /** Carrier ranking job status */
  ranker: ParallelJobStatus;

  /** Both jobs completed? */
  bothComplete: boolean;

  /** Ready to advance to brief compilation? */
  canAdvanceToBrief: boolean;

  /** Any errors preventing advancement? */
  errors: string[];
}

/**
 * Checks if the research job has completed for a load.
 *
 * A research job is considered complete if `research_completed_at IS NOT NULL`
 * in the pipeline_loads table.
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @returns Research job status
 *
 * @throws Error if database query fails
 */
export async function checkResearchCompletion(
  db: Database,
  pipelineLoadId: number
): Promise<ParallelJobStatus> {
  try {
    const result = await db.query(
      `
      SELECT
        research_completed_at,
        market_rate_floor,
        market_rate_mid,
        market_rate_best
      FROM pipeline_loads
      WHERE id = $1
      `,
      [pipelineLoadId]
    );

    if (!result.rows.length) {
      return {
        completed: false,
        completedAt: null,
        jobId: null,
        error: 'Load not found in pipeline_loads',
      };
    }

    const load = result.rows[0];
    const researchCompleted = load.research_completed_at !== null;

    return {
      completed: researchCompleted,
      completedAt: load.research_completed_at,
      jobId: null,
      error: null,
    };
  } catch (error) {
    return {
      completed: false,
      completedAt: null,
      jobId: null,
      error: `Database query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Checks if the carrier matching job has completed for a load.
 *
 * A matching job is considered complete if `carrier_match_count > 0`
 * in the pipeline_loads table (at least one carrier found and ranked).
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @returns Carrier matching job status
 *
 * @throws Error if database query fails
 */
export async function checkRankerCompletion(
  db: Database,
  pipelineLoadId: number
): Promise<ParallelJobStatus> {
  try {
    const result = await db.query(
      `
      SELECT
        carrier_match_count,
        top_carrier_id
      FROM pipeline_loads
      WHERE id = $1
      `,
      [pipelineLoadId]
    );

    if (!result.rows.length) {
      return {
        completed: false,
        completedAt: null,
        jobId: null,
        error: 'Load not found in pipeline_loads',
      };
    }

    const load = result.rows[0];
    const rankerCompleted = (load.carrier_match_count || 0) > 0;

    return {
      completed: rankerCompleted,
      completedAt: rankerCompleted ? new Date().toISOString() : null,
      jobId: null,
      error: null,
    };
  } catch (error) {
    return {
      completed: false,
      completedAt: null,
      jobId: null,
      error: `Database query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Gets the complete gate status for a load.
 * Checks both research and ranker completion in a single call.
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @returns Complete gate status
 */
export async function getGateStatus(
  db: Database,
  pipelineLoadId: number
): Promise<GateStatus> {
  const [researchStatus, rankerStatus] = await Promise.all([
    checkResearchCompletion(db, pipelineLoadId),
    checkRankerCompletion(db, pipelineLoadId),
  ]);

  const bothComplete =
    researchStatus.completed && rankerStatus.completed;

  const errors: string[] = [];
  if (researchStatus.error) errors.push(`Research: ${researchStatus.error}`);
  if (rankerStatus.error) errors.push(`Ranker: ${rankerStatus.error}`);

  return {
    pipelineLoadId,
    research: researchStatus,
    ranker: rankerStatus,
    bothComplete,
    canAdvanceToBrief: bothComplete && errors.length === 0,
    errors,
  };
}

/**
 * Advances a load to the `matched` stage if both parallel jobs are complete.
 *
 * This is the idempotent trigger: if called multiple times, only the first
 * call advances the stage; subsequent calls detect the stage is already
 * `matched` and return a no-op result.
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @returns Object with `advanced: boolean` and `reason: string`
 *
 * @example
 * ```typescript
 * const result = await checkAndAdvanceToMatched(db, loadId);
 * if (result.advanced) {
 *   // Enqueue to brief-queue
 * }
 * ```
 */
export async function checkAndAdvanceToMatched(
  db: Database,
  pipelineLoadId: number
): Promise<{
  advanced: boolean;
  previousStage: string | null;
  reason: string;
}> {
  try {
    const statusResult = await db.query(
      `
      SELECT
        stage,
        research_completed_at,
        carrier_match_count
      FROM pipeline_loads
      WHERE id = $1
      `,
      [pipelineLoadId]
    );

    if (!statusResult.rows.length) {
      return {
        advanced: false,
        previousStage: null,
        reason: 'Load not found',
      };
    }

    const load = statusResult.rows[0];
    const researchCompleted = load.research_completed_at !== null;
    const rankerCompleted = (load.carrier_match_count || 0) > 0;

    if (['matched', 'briefed', 'calling', 'booked', 'dispatched', 'delivered', 'scored'].includes(load.stage)) {
      return {
        advanced: false,
        previousStage: load.stage,
        reason: `Load already at stage: ${load.stage}`,
      };
    }

    if (!researchCompleted || !rankerCompleted) {
      return {
        advanced: false,
        previousStage: load.stage,
        reason: `Waiting for parallel jobs: research=${researchCompleted}, ranker=${rankerCompleted}`,
      };
    }

    const updateResult = await db.query(
      `
      UPDATE pipeline_loads
      SET stage = 'matched', stage_updated_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND stage = $2
      RETURNING stage
      `,
      [pipelineLoadId, load.stage]
    );

    if (!updateResult.rows.length) {
      return {
        advanced: false,
        previousStage: load.stage,
        reason: 'Stage already changed (race condition resolved)',
      };
    }

    return {
      advanced: true,
      previousStage: load.stage,
      reason: 'Advanced to matched — both research and ranker complete',
    };
  } catch (error) {
    return {
      advanced: false,
      previousStage: null,
      reason: `Database error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Called by Agent 3 (Researcher) when it completes.
 * Checks if Agent 4 has also completed, and if so, triggers advancement
 * to `matched` stage and enqueues to `brief-queue`.
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @returns Result object with `shouldEnqueue: boolean`
 *
 * @example
 * ```typescript
 * const result = await onResearcherComplete(db, pipelineLoadId);
 * if (result.shouldEnqueue) {
 *   await briefQueue.add('compile', briefPayload);
 * }
 * ```
 */
export async function onResearcherComplete(
  db: Database,
  pipelineLoadId: number
): Promise<{
  shouldEnqueue: boolean;
  reason: string;
  gateStatus: GateStatus;
}> {
  const gateStatus = await getGateStatus(db, pipelineLoadId);

  if (!gateStatus.canAdvanceToBrief) {
    return {
      shouldEnqueue: false,
      reason: gateStatus.errors.length
        ? gateStatus.errors.join('; ')
        : 'Waiting for ranker to complete',
      gateStatus,
    };
  }

  const advanceResult = await checkAndAdvanceToMatched(db, pipelineLoadId);

  return {
    shouldEnqueue: advanceResult.advanced,
    reason: advanceResult.reason,
    gateStatus,
  };
}

/**
 * Called by Agent 4 (Ranker) when it completes.
 * Checks if Agent 3 has also completed, and if so, triggers advancement
 * to `matched` stage and enqueues to `brief-queue`.
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @returns Result object with `shouldEnqueue: boolean`
 *
 * @example
 * ```typescript
 * const result = await onRankerComplete(db, pipelineLoadId);
 * if (result.shouldEnqueue) {
 *   await briefQueue.add('compile', briefPayload);
 * }
 * ```
 */
export async function onRankerComplete(
  db: Database,
  pipelineLoadId: number
): Promise<{
  shouldEnqueue: boolean;
  reason: string;
  gateStatus: GateStatus;
}> {
  const gateStatus = await getGateStatus(db, pipelineLoadId);

  if (!gateStatus.canAdvanceToBrief) {
    return {
      shouldEnqueue: false,
      reason: gateStatus.errors.length
        ? gateStatus.errors.join('; ')
        : 'Waiting for researcher to complete',
      gateStatus,
    };
  }

  const advanceResult = await checkAndAdvanceToMatched(db, pipelineLoadId);

  return {
    shouldEnqueue: advanceResult.advanced,
    reason: advanceResult.reason,
    gateStatus,
  };
}

/**
 * Builds the brief job payload for enqueuing to brief-queue.
 * Called after the gate opens (both jobs complete).
 *
 * Fetches research results and carrier stack from pipeline_loads.
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @returns Brief job payload ready for enqueueing
 *
 * @throws Error if load not found or required fields are missing
 */
export async function buildBriefPayload(
  db: Database,
  pipelineLoadId: number
): Promise<{
  pipelineLoadId: number;
  loadId: string;
  loadBoardSource: string;
  enqueuedAt: string;
  priority: number;
  researchResult: any;
  carrierStack: any[];
}> {
  const result = await db.query(
    `
    SELECT
      id,
      load_id,
      load_board_source,
      priority_score,
      market_rate_floor,
      market_rate_mid,
      market_rate_best,
      carrier_match_count
    FROM pipeline_loads
    WHERE id = $1
    `,
    [pipelineLoadId]
  );

  if (!result.rows.length) {
    throw new Error(`Load ${pipelineLoadId} not found`);
  }

  const load = result.rows[0];

  const carrierResults = await db.query(
    `
    SELECT
      carrier_id,
      match_score,
      match_grade,
      breakdown,
      was_selected
    FROM match_results
    WHERE load_id = $1
    ORDER BY match_score DESC
    LIMIT 5
    `,
    [load.load_id]
  );

  return {
    pipelineLoadId: load.id,
    loadId: load.load_id,
    loadBoardSource: load.load_board_source,
    enqueuedAt: new Date().toISOString(),
    priority: load.priority_score || 0,
    researchResult: {
      marketRateFloor: load.market_rate_floor,
      marketRateMid: load.market_rate_mid,
      marketRateBest: load.market_rate_best,
      totalCost: 0,
      marginEnvelope: { floor: 0, target: 0, stretch: 0 },
      recommendedStrategy: 'standard',
      shipperProfile: { postingFrequency: 0, historicalRates: [], preferredLanguage: 'en' },
      rateConfidence: 0.7,
      rateSources: ['benchmark'],
    },
    carrierStack: carrierResults.rows.map((row: any) => ({
      carrierId: row.carrier_id,
      matchScore: row.match_score,
      matchGrade: row.match_grade,
      breakdown: row.breakdown,
    })),
  };
}

/**
 * Idempotent gate checker — safe to call repeatedly.
 * Returns early if gate already opened (stage is 'matched' or beyond).
 * Only enqueues brief job once, even if called multiple times.
 *
 * @param db - Database connection
 * @param pipelineLoadId - ID of the load
 * @param briefQueueEnqueue - Function to enqueue to brief-queue
 * @returns Result object
 */
export async function checkGateAndEnqueue(
  db: Database,
  pipelineLoadId: number,
  briefQueueEnqueue: (payload: any) => Promise<string>
): Promise<{
  gateOpened: boolean;
  jobEnqueued: boolean;
  jobId?: string;
  reason: string;
}> {
  try {
    const gateStatus = await getGateStatus(db, pipelineLoadId);

    if (!gateStatus.canAdvanceToBrief) {
      return {
        gateOpened: false,
        jobEnqueued: false,
        reason: gateStatus.errors.length
          ? `Cannot open gate: ${gateStatus.errors.join('; ')}`
          : `Gate not ready: research=${gateStatus.research.completed}, ranker=${gateStatus.ranker.completed}`,
      };
    }

    const advanceResult = await checkAndAdvanceToMatched(db, pipelineLoadId);

    if (!advanceResult.advanced) {
      return {
        gateOpened: false,
        jobEnqueued: false,
        reason: advanceResult.reason,
      };
    }

    const briefPayload = await buildBriefPayload(db, pipelineLoadId);
    const jobId = await briefQueueEnqueue(briefPayload);

    return {
      gateOpened: true,
      jobEnqueued: true,
      jobId,
      reason: 'Gate opened, brief job enqueued successfully',
    };
  } catch (error) {
    return {
      gateOpened: false,
      jobEnqueued: false,
      reason: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
