/**
 * Myra Logistics — Cron Job Handlers
 *
 * Four cron jobs that are the operational heartbeat keeping the pipeline alive:
 * 1. Scanner Polling Trigger (every 30 seconds)
 * 2. Stuck Load Detector (every 5 minutes)
 * 3. Load Expiry Sweep (every 15 minutes)
 * 4. Dead Letter Sweep (every 10 minutes)
 *
 * @version 1.0
 * @owner Patrice Penda
 * @classification Technical — Engineering Only
 */

import { Queue, Worker } from 'bullmq';
import type {
  ScanResult,
  StuckLoadResult,
  ExpiryResult,
  DeadLetterResult,
  CronHealth,
  CronJobHealth,
  CronMetrics,
  CronScheduleConfig,
  CronJobHandle,
  CronSchedule,
  CronLog,
} from './cron-types';

// Type stubs for external dependencies (to be imported from actual modules)
interface Database {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

interface Redis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: any): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * CronJobHandlers: Manages all four cron jobs for pipeline orchestration
 *
 * This is the operational heartbeat. These jobs:
 * - Detect and recover from stalled loads
 * - Clean up expired loads
 * - Process dead letter queues
 * - Trigger scanner polling
 *
 * All four jobs must be robust and observable. They run independently
 * and don't block each other.
 */
export class CronJobHandlers {
  private config: CronScheduleConfig;
  private db: Database;
  private redis: Redis;
  private bullQueues: Map<string, Queue> = new Map();
  private jobHandles: Map<string, NodeJS.Timer> = new Map();
  private health: Map<string, CronJobHealth> = new Map();
  private metrics: Map<string, CronMetrics> = new Map();
  private logs: CronLog[] = [];
  private isRunning: boolean = false;

  constructor(config: CronScheduleConfig, db: Database, redis: Redis) {
    this.config = config;
    this.db = db;
    this.redis = redis;

    // Initialize health tracking for each job
    this.initializeHealthTracking();
  }

  /**
   * Initialize health tracking for each cron job
   */
  private initializeHealthTracking(): void {
    const jobNames = [
      'scanner-polling',
      'stuck-load-detector',
      'load-expiry-sweep',
      'dead-letter-sweep',
    ];

    for (const jobName of jobNames) {
      this.health.set(jobName, {
        jobName,
        enabled: this.config.enabled,
        lastRunAt: null,
        lastRunDurationMs: null,
        lastRunSucceeded: null,
        lastRunResult: null,
        consecutiveFailures: 0,
        nextRunAt: new Date().toISOString(),
        errorCountLastHour: 0,
      });

      this.metrics.set(jobName, {
        jobName,
        successCount: 0,
        failureCount: 0,
        avgDurationMs: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
        recentResults: [],
      });
    }
  }

  /**
   * Start all cron jobs
   *
   * @throws Error if initialization fails
   */
  public async startAllCrons(): Promise<void> {
    if (this.isRunning) {
      this.log('cron-scheduler', 'warn', 'Crons already running');
      return;
    }

    if (!this.config.enabled) {
      this.log(
        'cron-scheduler',
        'warn',
        'Cron scheduling is disabled in config'
      );
      return;
    }

    try {
      this.log('cron-scheduler', 'info', 'Starting all cron jobs');

      // Initialize queue connections
      await this.initializeQueues();

      // Start each cron job
      this.startScannerPolling();
      this.startStuckLoadDetector();
      this.startLoadExpirySweep();
      this.startDeadLetterSweep();

      this.isRunning = true;
      this.log('cron-scheduler', 'info', 'All cron jobs started successfully');
    } catch (error) {
      this.log('cron-scheduler', 'error', `Failed to start crons: ${error}`, {
        error,
      });
      throw error;
    }
  }

  /**
   * Initialize BullMQ queue connections
   */
  private async initializeQueues(): Promise<void> {
    const queueNames = [
      'qualify-queue',
      'research-queue',
      'match-queue',
      'brief-queue',
      'call-queue',
      'dispatch-queue',
      'feedback-queue',
      'callback-queue',
      'escalation-queue',
    ];

    for (const queueName of queueNames) {
      // Queue will be created on demand, store reference
      // In real implementation, this would connect to Upstash Redis
      this.bullQueues.set(queueName, new Queue(queueName));
    }
  }

  /**
   * CRON JOB 1: Scanner Polling Trigger
   *
   * Runs every 30 seconds (configurable).
   * Checks configured load board sources for new loads.
   * Enqueues to qualify-queue with deduplication.
   *
   * @returns Promise<ScanResult>
   */
  private startScannerPolling(): void {
    const jobName = 'scanner-polling';
    const interval = this.config.scannerPolling.pollingInterval;

    const handle = setInterval(async () => {
      const startTime = Date.now();

      try {
        const result = await this.runScannerPoll();
        const duration = Date.now() - startTime;

        this.recordSuccess(jobName, result, duration);
        this.log(jobName, 'info', 'Scanner polling completed', {
          ...result,
          durationMs: duration,
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        this.recordFailure(jobName, error, duration);
        this.log(jobName, 'error', `Scanner polling failed: ${error}`, {
          error,
          durationMs: duration,
        });
      }
    }, interval);

    this.jobHandles.set(jobName, handle);
    const jobHealth = this.health.get(jobName)!;
    jobHealth.nextRunAt = new Date(Date.now() + interval).toISOString();
  }

  /**
   * Run scanner polling: check load board sources for new loads
   *
   * @private
   */
  private async runScannerPoll(): Promise<ScanResult> {
    const timestamp = new Date().toISOString();
    let totalScanned = 0;
    let newLoadsEnqueued = 0;
    let duplicatesSkipped = 0;
    let enqueueFailed = 0;
    const sourceBreakdown = [];
    const errors = [];

    for (const source of this.config.scannerPolling.activeSources) {
      try {
        const result = await this.pollSourceForLoads(source);

        totalScanned += result.scanned;
        newLoadsEnqueued += result.newEnqueued;
        duplicatesSkipped += result.duplicates;
        enqueueFailed += result.enqueueFailed;

        sourceBreakdown.push({
          source,
          scanned: result.scanned,
          new: result.newEnqueued,
          duplicates: result.duplicates,
          errors: result.enqueueFailed,
        });
      } catch (error) {
        errors.push({
          source,
          message: String(error),
        });
        // Continue with other sources — don't fail the entire scan
      }
    }

    return {
      success: errors.length === 0,
      timestamp,
      totalScanned,
      newLoadsEnqueued,
      duplicatesSkipped,
      enqueueFailed,
      sourceBreakdown,
      errors,
      durationMs: 0, // Populated by caller
    };
  }

  /**
   * Poll a single load board source for new loads
   *
   * @private
   */
  private async pollSourceForLoads(source: string): Promise<{
    scanned: number;
    newEnqueued: number;
    duplicates: number;
    enqueueFailed: number;
  }> {
    // This would call actual load board APIs (DAT, 123Loadboard, etc.)
    // For now, return a stub result
    return {
      scanned: 0,
      newEnqueued: 0,
      duplicates: 0,
      enqueueFailed: 0,
    };
  }

  /**
   * CRON JOB 2: Stuck Load Detector
   *
   * Runs every 5 minutes (configurable).
   * Queries pipeline_loads for any load in the same non-terminal stage for > 30 minutes.
   * For each stuck load:
   *   - If retryable stage: re-enqueue to the appropriate queue
   *   - If already retried max times: escalate to escalation-queue
   *   - Log the detection with stage, duration, and action taken
   *
   * @returns Promise<StuckLoadResult>
   */
  private startStuckLoadDetector(): void {
    const jobName = 'stuck-load-detector';
    const interval = this.config.stuckLoadDetector.checkInterval;

    const handle = setInterval(async () => {
      const startTime = Date.now();

      try {
        const result = await this.detectStuckLoads();
        const duration = Date.now() - startTime;

        this.recordSuccess(jobName, result, duration);
        this.log(jobName, 'info', 'Stuck load detection completed', {
          ...result,
          durationMs: duration,
        });

        // Alert if threshold exceeded
        if (result.stuckLoadsFound > 10) {
          this.log(jobName, 'warn', 'High number of stuck loads detected', {
            stuckLoadsFound: result.stuckLoadsFound,
          });
        }
      } catch (error) {
        const duration = Date.now() - startTime;
        this.recordFailure(jobName, error, duration);
        this.log(jobName, 'error', `Stuck load detection failed: ${error}`, {
          error,
          durationMs: duration,
        });
      }
    }, interval);

    this.jobHandles.set(jobName, handle);
    const jobHealth = this.health.get(jobName)!;
    jobHealth.nextRunAt = new Date(Date.now() + interval).toISOString();
  }

  /**
   * Detect loads stuck in a stage and attempt recovery
   *
   * @private
   */
  private async detectStuckLoads(): Promise<StuckLoadResult> {
    const timestamp = new Date().toISOString();
    const thresholdMs =
      this.config.stuckLoadDetector.stuckThresholdMinutes * 60 * 1000;

    // Query for stuck loads
    const stuckLoads = await this.db.query(
      `
      SELECT id, load_id, stage, stage_updated_at, call_attempts
      FROM pipeline_loads
      WHERE stage NOT IN ('scored', 'disqualified', 'expired', 'declined', 'booked', 'dispatched', 'delivered')
      AND stage_updated_at < NOW() - INTERVAL '1 minute' * $1
      ORDER BY stage_updated_at ASC
      LIMIT 100
    `,
      [this.config.stuckLoadDetector.stuckThresholdMinutes]
    );

    let requeued = 0;
    let escalated = 0;
    const actions = [];

    for (const load of stuckLoads.rows) {
      const stuckDurationMs =
        Date.now() - new Date(load.stage_updated_at).getTime();
      const retryCount = load.call_attempts || 0;

      let action: 'requeued' | 'escalated' | 'skipped' = 'skipped';
      let reason = 'No action taken';

      if (
        this.config.stuckLoadDetector.autoRetryEnabled &&
        retryCount < this.config.stuckLoadDetector.maxRetries
      ) {
        // Re-enqueue to the appropriate queue for this stage
        const queueName = this.getQueueNameForStage(load.stage);
        if (queueName) {
          try {
            const queue = this.bullQueues.get(queueName);
            if (queue) {
              await queue.add('load-job', { pipelineLoadId: load.id });
              action = 'requeued';
              reason = `Re-enqueued to ${queueName}`;
              requeued++;
            }
          } catch (error) {
            reason = `Failed to re-enqueue: ${error}`;
          }
        }
      } else if (retryCount >= this.config.stuckLoadDetector.maxRetries) {
        // Escalate to human review
        try {
          const escalationQueue = this.bullQueues.get('escalation-queue');
          if (escalationQueue) {
            await escalationQueue.add('escalation', {
              pipelineLoadId: load.id,
              reason: 'Load stuck in stage, max retries exceeded',
            });
            action = 'escalated';
            reason = 'Escalated to human review';
            escalated++;
          }
        } catch (error) {
          reason = `Failed to escalate: ${error}`;
        }
      }

      actions.push({
        pipelineLoadId: load.id,
        loadId: load.load_id,
        stage: load.stage,
        stuckDurationMinutes: Math.floor(stuckDurationMs / 60000),
        retryCount,
        action,
        reason,
      });
    }

    return {
      success: true,
      timestamp,
      stuckLoadsFound: stuckLoads.rows.length,
      requeued,
      escalated,
      actions,
      durationMs: 0, // Populated by caller
    };
  }

  /**
   * Get the appropriate queue name for a given pipeline stage
   *
   * @private
   */
  private getQueueNameForStage(stage: string): string | null {
    const stageToQueue: Record<string, string> = {
      scanned: 'qualify-queue',
      qualified: 'research-queue', // Could also go to match-queue
      researched: 'brief-queue', // Actually handled by completion gate
      matched: 'brief-queue',
      briefed: 'call-queue',
      calling: 'call-queue',
      callback: 'callback-queue',
    };

    return stageToQueue[stage] || null;
  }

  /**
   * CRON JOB 3: Load Expiry Sweep
   *
   * Runs every 15 minutes (configurable).
   * Queries pipeline_loads where pickup_date has passed AND stage is NOT in [BOOKED, DISPATCHED, DELIVERED, SCORED].
   * Marks these loads as EXPIRED stage.
   * Cancels any pending jobs in queues for these loads.
   *
   * @returns Promise<ExpiryResult>
   */
  private startLoadExpirySweep(): void {
    const jobName = 'load-expiry-sweep';
    const interval = this.config.loadExpirySweep.sweepInterval;

    const handle = setInterval(async () => {
      const startTime = Date.now();

      try {
        const result = await this.sweepExpiredLoads();
        const duration = Date.now() - startTime;

        this.recordSuccess(jobName, result, duration);
        this.log(jobName, 'info', 'Load expiry sweep completed', {
          ...result,
          durationMs: duration,
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        this.recordFailure(jobName, error, duration);
        this.log(jobName, 'error', `Load expiry sweep failed: ${error}`, {
          error,
          durationMs: duration,
        });
      }
    }, interval);

    this.jobHandles.set(jobName, handle);
    const jobHealth = this.health.get(jobName)!;
    jobHealth.nextRunAt = new Date(Date.now() + interval).toISOString();
  }

  /**
   * Expire loads whose pickup date has passed
   *
   * @private
   */
  private async sweepExpiredLoads(): Promise<ExpiryResult> {
    const timestamp = new Date().toISOString();
    const gracePeriodHours = this.config.loadExpirySweep.gracePeriodHours;

    // Find expired loads
    const expiredLoads = await this.db.query(
      `
      SELECT id, load_id, pickup_date, stage
      FROM pipeline_loads
      WHERE stage NOT IN ('booked', 'dispatched', 'delivered', 'scored', 'expired', 'disqualified')
      AND pickup_date < NOW() - INTERVAL '1 hour' * $1
      LIMIT 500
    `,
      [gracePeriodHours]
    );

    let loadsExpired = 0;
    let jobsCancelled = 0;
    const expiredLoadIds: number[] = [];
    const actions = [];

    for (const load of expiredLoads.rows) {
      try {
        // Mark load as expired
        await this.db.query(
          `
          UPDATE pipeline_loads
          SET stage = 'expired', stage_updated_at = NOW()
          WHERE id = $1
        `,
          [load.id]
        );

        // Cancel pending jobs for this load
        const cancelledCount = await this.cancelPendingJobsForLoad(load.id);

        expiredLoadIds.push(load.id);
        loadsExpired++;
        jobsCancelled += cancelledCount;

        actions.push({
          pipelineLoadId: load.id,
          loadId: load.load_id,
          pickupDate: load.pickup_date,
          stage: load.stage,
          jobsCancelledCount: cancelledCount,
        });
      } catch (error) {
        this.log('load-expiry-sweep', 'error', `Failed to expire load ${load.id}`, {
          error,
        });
      }
    }

    return {
      success: true,
      timestamp,
      loadsExpired,
      expiredLoadIds,
      jobsCancelled,
      actions,
      durationMs: 0, // Populated by caller
    };
  }

  /**
   * Cancel all pending jobs for a load across all queues
   *
   * @private
   */
  private async cancelPendingJobsForLoad(pipelineLoadId: number): Promise<number> {
    let cancelledCount = 0;

    for (const [, queue] of this.bullQueues) {
      try {
        // Get all jobs for this load and remove them
        const jobs = await queue.getJobs(['wait', 'delayed', 'active']);
        for (const job of jobs) {
          if (job.data.pipelineLoadId === pipelineLoadId) {
            await job.remove();
            cancelledCount++;
          }
        }
      } catch (error) {
        this.log('load-expiry-sweep', 'warn', `Failed to cancel jobs in queue`, {
          error,
          pipelineLoadId,
        });
      }
    }

    return cancelledCount;
  }

  /**
   * CRON JOB 4: Dead Letter Sweep
   *
   * Runs every 10 minutes (configurable).
   * Checks all 9 queues for failed jobs that have exhausted retries.
   * Moves failed job data to agent_jobs table with status = 'dead_letter'.
   * Enqueues an escalation notification for each.
   *
   * @returns Promise<DeadLetterResult>
   */
  private startDeadLetterSweep(): void {
    const jobName = 'dead-letter-sweep';
    const interval = this.config.deadLetterSweep.sweepInterval;

    const handle = setInterval(async () => {
      const startTime = Date.now();

      try {
        const result = await this.sweepDeadLetterQueues();
        const duration = Date.now() - startTime;

        this.recordSuccess(jobName, result, duration);
        this.log(jobName, 'info', 'Dead letter sweep completed', {
          ...result,
          durationMs: duration,
        });

        // Alert if threshold exceeded
        if (result.totalFailedJobs > this.config.deadLetterSweep.alertThreshold) {
          this.log(jobName, 'warn', 'Dead letter threshold exceeded', {
            totalFailedJobs: result.totalFailedJobs,
            threshold: this.config.deadLetterSweep.alertThreshold,
          });
        }
      } catch (error) {
        const duration = Date.now() - startTime;
        this.recordFailure(jobName, error, duration);
        this.log(jobName, 'error', `Dead letter sweep failed: ${error}`, {
          error,
          durationMs: duration,
        });
      }
    }, interval);

    this.jobHandles.set(jobName, handle);
    const jobHealth = this.health.get(jobName)!;
    jobHealth.nextRunAt = new Date(Date.now() + interval).toISOString();
  }

  /**
   * Sweep dead letter queues and move failed jobs to database
   *
   * @private
   */
  private async sweepDeadLetterQueues(): Promise<DeadLetterResult> {
    const timestamp = new Date().toISOString();
    let totalFailedJobs = 0;
    let jobsMoved = 0;
    let notificationsSent = 0;
    const queueBreakdown = [];
    const movedJobs = [];

    for (const queueName of this.config.deadLetterSweep.queueNames) {
      try {
        const queue = this.bullQueues.get(queueName);
        if (!queue) continue;

        // Get failed jobs from the queue
        const failedJobs = await queue.getFailed(0, -1);
        totalFailedJobs += failedJobs.length;

        let queueMoved = 0;
        let queueNotifications = 0;

        for (const job of failedJobs) {
          try {
            // Record in agent_jobs with status 'dead_letter'
            const pipelineLoadId = job.data.pipelineLoadId || null;
            const failureReason = job.failedReason || 'Unknown';
            const lastError = job.stacktrace?.[0] || '';

            await this.db.query(
              `
              INSERT INTO agent_jobs (
                job_id, queue_name, pipeline_load_id, status,
                attempts, max_attempts, error_message, created_at
              ) VALUES ($1, $2, $3, 'dead_letter', $4, $5, $6, NOW())
              ON CONFLICT (job_id) DO UPDATE SET
                status = 'dead_letter',
                error_message = EXCLUDED.error_message
            `,
              [job.id, queueName, pipelineLoadId, job.attemptsMade, job.opts?.attempts || 3, lastError]
            );

            // Send escalation notification
            const escalationQueue = this.bullQueues.get('escalation-queue');
            if (escalationQueue) {
              await escalationQueue.add(
                'escalation',
                {
                  pipelineLoadId,
                  reason: `Job failed and moved to dead letter: ${failureReason}`,
                  queueName,
                  jobId: job.id,
                },
                { priority: 10 } // High priority
              );
              queueNotifications++;
              notificationsSent++;
            }

            // Remove the job from failed
            await job.remove();
            queueMoved++;

            movedJobs.push({
              jobId: job.id ?? '',
              queueName,
              pipelineLoadId: pipelineLoadId || 0,
              failureReason,
              lastError,
              attempts: job.attemptsMade,
            });
          } catch (error) {
            this.log('dead-letter-sweep', 'error', `Failed to process dead letter job`, {
              jobId: job.id,
              queueName,
              error,
            });
          }
        }

        jobsMoved += queueMoved;

        queueBreakdown.push({
          queueName,
          failedCount: failedJobs.length,
          moved: queueMoved,
          notificationsSent: queueNotifications,
        });
      } catch (error) {
        this.log('dead-letter-sweep', 'error', `Failed to process queue ${queueName}`, {
          error,
        });
      }
    }

    return {
      success: true,
      timestamp,
      totalFailedJobs,
      jobsMoved,
      notificationsSent,
      queueBreakdown,
      movedJobs,
      durationMs: 0, // Populated by caller
    };
  }

  /**
   * Stop all cron jobs gracefully
   */
  public async stopAllCrons(): Promise<void> {
    if (!this.isRunning) {
      this.log('cron-scheduler', 'info', 'Crons not running');
      return;
    }

    this.log('cron-scheduler', 'info', 'Stopping all cron jobs');

    for (const [jobName, handle] of this.jobHandles) {
      if (handle) {
        clearInterval(handle as unknown as NodeJS.Timeout);
        this.log('cron-scheduler', 'info', `Stopped cron: ${jobName}`);
      }
    }

    this.jobHandles.clear();
    this.isRunning = false;
    this.log('cron-scheduler', 'info', 'All cron jobs stopped');
  }

  /**
   * Get current health status of all crons
   */
  public getCronHealth(): CronHealth {
    const jobs: Record<string, CronJobHealth> = {};
    let totalErrorsLastHour = 0;
    const criticalIssues: string[] = [];

    for (const [jobName, health] of this.health) {
      jobs[jobName] = health;
      totalErrorsLastHour += health.errorCountLastHour;

      if (health.consecutiveFailures > 5) {
        criticalIssues.push(
          `${jobName} has failed ${health.consecutiveFailures} consecutive times`
        );
      }
    }

    return {
      healthy: criticalIssues.length === 0,
      timestamp: new Date().toISOString(),
      jobs,
      totalErrorsLastHour,
      criticalIssues,
    };
  }

  /**
   * Get metrics for a specific cron job
   */
  public getCronMetrics(jobName: string): CronMetrics | null {
    return this.metrics.get(jobName) || null;
  }

  /**
   * Record a successful cron execution
   *
   * @private
   */
  private recordSuccess(jobName: string, result: any, durationMs: number): void {
    const jobMetrics = this.metrics.get(jobName);
    const jobHealth = this.health.get(jobName);

    if (!jobMetrics || !jobHealth) return;

    // Update metrics
    jobMetrics.successCount++;
    jobMetrics.minDurationMs = Math.min(jobMetrics.minDurationMs, durationMs);
    jobMetrics.maxDurationMs = Math.max(jobMetrics.maxDurationMs, durationMs);

    // Recalculate average
    const totalRuns = jobMetrics.successCount + jobMetrics.failureCount;
    jobMetrics.avgDurationMs = Math.round(
      (jobMetrics.avgDurationMs * (totalRuns - 1) + durationMs) / totalRuns
    );

    // Update recent results
    jobMetrics.recentResults.push({
      timestamp: new Date().toISOString(),
      durationMs,
      success: true,
      resultSummary: result,
    });

    if (jobMetrics.recentResults.length > 10) {
      jobMetrics.recentResults.shift();
    }

    // Update health
    jobHealth.lastRunAt = new Date().toISOString();
    jobHealth.lastRunDurationMs = durationMs;
    jobHealth.lastRunSucceeded = true;
    jobHealth.lastRunResult = result;
    jobHealth.consecutiveFailures = 0;

    // Calculate next run
    const interval = this.getIntervalForJob(jobName);
    if (interval) {
      jobHealth.nextRunAt = new Date(Date.now() + interval).toISOString();
    }
  }

  /**
   * Record a failed cron execution
   *
   * @private
   */
  private recordFailure(jobName: string, error: any, durationMs: number): void {
    const jobMetrics = this.metrics.get(jobName);
    const jobHealth = this.health.get(jobName);

    if (!jobMetrics || !jobHealth) return;

    // Update metrics
    jobMetrics.failureCount++;
    jobMetrics.minDurationMs = Math.min(jobMetrics.minDurationMs, durationMs);
    jobMetrics.maxDurationMs = Math.max(jobMetrics.maxDurationMs, durationMs);

    // Recalculate average
    const totalRuns = jobMetrics.successCount + jobMetrics.failureCount;
    jobMetrics.avgDurationMs = Math.round(
      (jobMetrics.avgDurationMs * (totalRuns - 1) + durationMs) / totalRuns
    );

    // Update recent results
    jobMetrics.recentResults.push({
      timestamp: new Date().toISOString(),
      durationMs,
      success: false,
      resultSummary: { error: String(error) },
    });

    if (jobMetrics.recentResults.length > 10) {
      jobMetrics.recentResults.shift();
    }

    // Update health
    jobHealth.lastRunAt = new Date().toISOString();
    jobHealth.lastRunDurationMs = durationMs;
    jobHealth.lastRunSucceeded = false;
    jobHealth.consecutiveFailures++;
    jobHealth.errorCountLastHour++;

    // Calculate next run
    const interval = this.getIntervalForJob(jobName);
    if (interval) {
      jobHealth.nextRunAt = new Date(Date.now() + interval).toISOString();
    }
  }

  /**
   * Get the interval for a job in milliseconds
   *
   * @private
   */
  private getIntervalForJob(jobName: string): number | null {
    switch (jobName) {
      case 'scanner-polling':
        return this.config.scannerPolling.pollingInterval;
      case 'stuck-load-detector':
        return this.config.stuckLoadDetector.checkInterval;
      case 'load-expiry-sweep':
        return this.config.loadExpirySweep.sweepInterval;
      case 'dead-letter-sweep':
        return this.config.deadLetterSweep.sweepInterval;
      default:
        return null;
    }
  }

  /**
   * Structured logging for cron operations
   *
   * @private
   */
  private log(
    jobName: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    context: Record<string, any> = {}
  ): void {
    const logEntry: CronLog = {
      timestamp: new Date().toISOString(),
      jobName,
      level,
      message,
      context,
    };

    this.logs.push(logEntry);

    // Keep logs to last 1000 entries
    if (this.logs.length > 1000) {
      this.logs.shift();
    }

    // Log to console with structured format
    console.log(
      JSON.stringify({
        component: 'cron',
        jobName,
        level,
        message,
        ...context,
        timestamp: logEntry.timestamp,
      })
    );
  }

  /**
   * Get recent logs (for debugging)
   */
  public getRecentLogs(limit: number = 100): CronLog[] {
    return this.logs.slice(-limit);
  }
}

/**
 * Factory function to create and configure CronJobHandlers
 *
 * @example
 * const handlers = await setupCronSchedule(db, redis, {
 *   enabled: true,
 *   scannerPolling: { pollingInterval: 30000, ... },
 *   // ...
 * });
 *
 * await handlers.startAllCrons();
 */
export async function setupCronSchedule(
  db: Database,
  redis: Redis,
  config: CronScheduleConfig
): Promise<CronJobHandlers> {
  const handlers = new CronJobHandlers(config, db, redis);
  return handlers;
}

/**
 * Default configuration for all cron jobs
 *
 * Use this as a baseline and override specific values as needed.
 */
export const DEFAULT_CRON_CONFIG: CronScheduleConfig = {
  enabled: process.env.PIPELINE_ENABLED === 'true',

  scannerPolling: {
    pollingInterval: 30000, // 30 seconds
    activeSources: ['dat', '123lb', 'truckstop'],
    maxBatchSize: 100,
    deduplicationEnabled: true,
    minAgeHours: 0,
  },

  stuckLoadDetector: {
    checkInterval: 300000, // 5 minutes
    stuckThresholdMinutes: 30,
    maxRetries: 3,
    stagesToMonitor: [
      'scanned',
      'qualified',
      'researched',
      'matched',
      'briefed',
      'calling',
    ],
    autoRetryEnabled: true,
  },

  loadExpirySweep: {
    sweepInterval: 900000, // 15 minutes
    gracePeriodHours: 2,
    exemptStages: ['booked', 'dispatched', 'delivered', 'scored', 'expired', 'disqualified'],
  },

  deadLetterSweep: {
    sweepInterval: 600000, // 10 minutes
    queueNames: [
      'qualify-queue',
      'research-queue',
      'match-queue',
      'brief-queue',
      'call-queue',
      'dispatch-queue',
      'feedback-queue',
      'callback-queue',
      'escalation-queue',
    ],
    alertThreshold: 5,
  },

  monitoring: {
    loggingEnabled: true,
    errorRateAlertThreshold: 10, // percent
    consecutiveFailuresAlert: 5,
  },
};
