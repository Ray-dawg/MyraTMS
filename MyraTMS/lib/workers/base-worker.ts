/**
 * BASE WORKER PATTERN FOR MYRA AI PIPELINE
 *
 * This abstract class provides the standard BullMQ worker lifecycle for all 8 agent workers.
 * Every agent extends this class and implements the abstract `process()` method.
 *
 * Lifecycle:
 * 1. Job received from queue
 * 2. Validate payload and load state in DB
 * 3. Execute agent-specific logic (abstract method)
 * 4. Update pipeline_loads stage and agent_jobs table
 * 5. Enqueue to next stage
 * 6. Log completion
 *
 * Error handling: Retries with exponential backoff, dead letter queue support, graceful shutdown
 */

import { Worker, Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

/**
 * Base job payload structure - all jobs have at minimum these fields
 */
export interface BaseJobPayload {
  pipelineLoadId: number;
  loadId: string;
  loadBoardSource: string;
  enqueuedAt: string; // ISO timestamp
  priority: number;
}

/**
 * Standard result structure returned by process() implementation
 */
export interface ProcessResult {
  success: boolean;
  pipelineLoadId: number;
  stage: string;
  nextStage?: string;
  duration: number; // milliseconds
  error?: string;
  details?: Record<string, any>;
}

/**
 * Configuration for a worker
 */
export interface WorkerConfig {
  queueName: string;
  expectedStage: string; // The stage loads should be in when they arrive
  nextStage?: string; // The stage to advance to after processing (if null, subclass handles it)
  concurrency: number;
  retryConfig: {
    attempts: number;
    backoff: {
      type: 'exponential' | 'fixed';
      delay: number; // milliseconds
    };
  };
  redis: Redis;
}

/**
 * Abstract base worker class
 * Extend this class and implement the abstract `process()` method
 */
export abstract class BaseWorker<T extends BaseJobPayload> {
  protected worker: Worker<T>;
  protected config: WorkerConfig;
  protected redis: Redis;
  protected queueName: string;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.redis = config.redis;
    this.queueName = config.queueName;

    this.worker = new Worker<T>(
      config.queueName,
      (job: Job<T>) => this.handleJob(job),
      {
        connection: config.redis,
        concurrency: config.concurrency,
      }
    );

    this.setupEventHandlers();
  }

  /**
   * Main job handler - orchestrates the full lifecycle
   */
  private async handleJob(job: Job<T>): Promise<ProcessResult> {
    const startTime = Date.now();
    const { pipelineLoadId } = job.data;

    try {
      logger.info(`[${this.queueName}] Job ${job.id} received for load ${pipelineLoadId}`);

      // 1. VALIDATE: Check load exists and is in expected stage
      const load = await this.validateLoad(pipelineLoadId);
      if (!load) {
        logger.warn(
          `[${this.queueName}] Load ${pipelineLoadId} not found or not in stage ${this.config.expectedStage}. Skipping.`
        );
        return {
          success: false,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: Date.now() - startTime,
          error: 'stage_mismatch',
        };
      }

      // 2. PROCESS: Execute agent-specific logic (implemented by subclass)
      logger.debug(`[${this.queueName}] Starting process for load ${pipelineLoadId}`);
      const result = await this.process(job.data);

      // 3. UPDATE: Write results to pipeline_loads and update stage
      if (result.success && this.config.nextStage) {
        await this.updatePipelineLoad(pipelineLoadId, result);
      }

      // 4. LOG: Record job completion in agent_jobs table
      await this.logJobCompletion(job.id ?? '', pipelineLoadId, result, null);

      logger.info(
        `[${this.queueName}] Job ${job.id} completed successfully. Load advanced to ${this.config.nextStage || 'next queue'}.`
      );

      return {
        success: true,
        pipelineLoadId,
        stage: this.config.expectedStage,
        nextStage: this.config.nextStage,
        duration: Date.now() - startTime,
        details: result.details,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        `[${this.queueName}] Job ${job.id} failed: ${errorMessage}`,
        { pipelineLoadId, error }
      );

      // Log failure in agent_jobs
      await this.logJobCompletion(job.id ?? '', pipelineLoadId, null, errorMessage);

      // Throw to trigger BullMQ retry logic
      throw error;
    }
  }

  /**
   * Validate that the load exists and is in the expected stage
   */
  protected async validateLoad(pipelineLoadId: number): Promise<any> {
    try {
      const result = await db.query(
        'SELECT * FROM pipeline_loads WHERE id = $1 AND stage = $2',
        [pipelineLoadId, this.config.expectedStage]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      logger.error(`Database error validating load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Update pipeline_loads table with stage advancement and any result data
   * Subclasses can override to add custom fields
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    try {
      await db.query(
        `UPDATE pipeline_loads
         SET stage = $1, stage_updated_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [this.config.nextStage, pipelineLoadId]
      );

      logger.debug(
        `[${this.queueName}] Pipeline load ${pipelineLoadId} advanced to stage: ${this.config.nextStage}`
      );
    } catch (error) {
      logger.error(`Failed to update pipeline load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Log job completion/failure to agent_jobs table for observability
   */
  protected async logJobCompletion(
    jobId: string,
    pipelineLoadId: number,
    result: any,
    error: string | null
  ): Promise<void> {
    try {
      const status = error ? 'failed' : 'completed';
      const now = new Date().toISOString();

      await db.query(
        `INSERT INTO agent_jobs (job_id, queue_name, pipeline_load_id, status, result, error_message, completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_id) DO UPDATE SET
           status = $4,
           result = $5,
           error_message = $6,
           completed_at = $7`,
        [
          jobId,
          this.queueName,
          pipelineLoadId,
          status,
          result ? JSON.stringify(result) : null,
          error,
          now,
          now,
        ]
      );
    } catch (error) {
      logger.error(`Failed to log job completion for ${jobId}:`, error);
      // Don't throw - logging failure shouldn't fail the job
    }
  }

  /**
   * Abstract method - each subclass must implement the core business logic
   * This is where the agent-specific processing happens
   */
  abstract process(payload: T): Promise<any>;

  /**
   * Setup event handlers for worker lifecycle
   */
  private setupEventHandlers(): void {
    this.worker.on('active', (job: Job) => {
      logger.debug(`[${this.queueName}] Job ${job.id} is active (started processing)`);
    });

    this.worker.on('completed', (job: Job) => {
      logger.info(`[${this.queueName}] Job ${job.id} completed`);
    });

    this.worker.on('failed', (job: Job | undefined, error: Error) => {
      logger.error(`[${this.queueName}] Job ${job?.id} failed:`, error);
    });

    this.worker.on('error', (error: Error) => {
      logger.error(`[${this.queueName}] Worker error:`, error);
    });

    this.worker.on('paused', () => {
      logger.info(`[${this.queueName}] Worker paused`);
    });

    this.worker.on('resumed', () => {
      logger.info(`[${this.queueName}] Worker resumed`);
    });
  }

  /**
   * Health check - returns whether the worker is healthy
   */
  public async healthCheck(): Promise<boolean> {
    try {
      const ping = await this.redis.ping();
      return ping === 'PONG';
    } catch (error) {
      logger.error(`Health check failed for ${this.queueName}:`, error);
      return false;
    }
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    try {
      logger.info(`[${this.queueName}] Shutting down worker gracefully...`);
      await this.worker.close();
      logger.info(`[${this.queueName}] Worker shutdown complete`);
    } catch (error) {
      logger.error(`Error during shutdown of ${this.queueName}:`, error);
      throw error;
    }
  }

  /**
   * Get worker instance for testing or direct access
   */
  public getWorker(): Worker<T> {
    return this.worker;
  }

  /**
   * Pause the worker (stops processing new jobs)
   */
  public async pause(): Promise<void> {
    await this.worker.pause();
    logger.info(`[${this.queueName}] Worker paused`);
  }

  /**
   * Resume the worker
   */
  public async resume(): Promise<void> {
    await this.worker.resume();
    logger.info(`[${this.queueName}] Worker resumed`);
  }
}

export default BaseWorker;
