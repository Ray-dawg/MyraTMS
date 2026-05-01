/**
 * BullMQ Queue Definitions and Configuration
 *
 * Defines all 9 queues in the pipeline with their concurrency limits,
 * retry strategies, and rate limiting configuration. Every agent reads from
 * and writes to queues defined here.
 *
 * @module lib/pipeline/queues
 */

import { Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq';

/**
 * Standard retry configuration options.
 * Used across different retry strategies in the pipeline.
 */
export interface RetryConfig {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Queue configuration combining BullMQ options with Myra-specific metadata.
 */
export interface QueueConfig extends Omit<QueueOptions, 'connection'> {
  queueName: string;
  description: string;
  concurrency: number;
  retryConfig: RetryConfig;
  priority: boolean;
  delayable: boolean;
}

/**
 * Retry configuration: 3 attempts with exponential backoff (30s initial)
 * Used for: qualify-queue, research-queue, match-queue, brief-queue, dispatch-queue
 */
export const RETRY_STANDARD: RetryConfig = {
  attempts: 3,
  initialDelayMs: 30000, // 30 seconds
  maxDelayMs: 120000, // 2 minutes
  backoffMultiplier: 2,
};

/**
 * Retry configuration: 5 attempts with exponential backoff (60s initial)
 * Used for: research-queue (Claude API rate limits)
 */
export const RETRY_EXTENDED: RetryConfig = {
  attempts: 5,
  initialDelayMs: 60000, // 60 seconds
  maxDelayMs: 960000, // 16 minutes
  backoffMultiplier: 2,
};

/**
 * Retry configuration: 2 attempts with fixed 30s backoff
 * Used for: brief-queue (merge point, time-sensitive)
 */
export const RETRY_BRIEF: RetryConfig = {
  attempts: 2,
  initialDelayMs: 30000,
  maxDelayMs: 30000,
  backoffMultiplier: 1,
};

/**
 * Retry configuration: No retries (single attempt)
 * Used for: call-queue (voice calls are not idempotent)
 */
export const RETRY_NO_RETRY: RetryConfig = {
  attempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
};

/**
 * Retry configuration: Long delay backoff
 * Used for: feedback-queue (post-delivery, not time-sensitive)
 */
export const RETRY_LONG_BACKOFF: RetryConfig = {
  attempts: 3,
  initialDelayMs: 300000, // 5 minutes
  maxDelayMs: 900000, // 15 minutes
  backoffMultiplier: 2,
};

/**
 * Queue 1: Qualify Queue
 * Source: Scanner (Agent 1) → Target: Qualifier (Agent 2)
 * Concurrency: 50 (pure SQL/logic, very fast)
 */
export const QUALIFY_QUEUE_CONFIG: QueueConfig = {
  queueName: 'qualify-queue',
  description: 'Qualifier (Agent 2) — Determines load profitability',
  concurrency: 50,
  retryConfig: RETRY_STANDARD,
  priority: true,
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_STANDARD.attempts,
    backoff: {
      type: 'exponential',
      delay: RETRY_STANDARD.initialDelayMs,
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
};

/**
 * Queue 2: Research Queue
 * Source: Qualifier (Agent 2) → Target: Researcher (Agent 3)
 * Concurrency: 20 (Claude API calls, ~2-5s each)
 * Priority: By priority_score DESC
 */
export const RESEARCH_QUEUE_CONFIG: QueueConfig = {
  queueName: 'research-queue',
  description: 'Researcher (Agent 3) — Rate analysis and market intelligence',
  concurrency: 20,
  retryConfig: RETRY_EXTENDED, // Extended retry for API rate limits
  priority: true,
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_EXTENDED.attempts,
    backoff: {
      type: 'exponential',
      delay: RETRY_EXTENDED.initialDelayMs,
    },
    removeOnComplete: {
      age: 3600,
    },
    removeOnFail: {
      age: 86400,
    },
  },
};

/**
 * Queue 3: Match Queue
 * Source: Qualifier (Agent 2) → Target: Ranker (Agent 4)
 * Concurrency: 20 (database queries, fast)
 * Priority: By priority_score DESC
 */
export const MATCH_QUEUE_CONFIG: QueueConfig = {
  queueName: 'match-queue',
  description: 'Carrier Ranker (Agent 4) — Matches and ranks carriers',
  concurrency: 20,
  retryConfig: RETRY_STANDARD,
  priority: true,
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_STANDARD.attempts,
    backoff: {
      type: 'exponential',
      delay: RETRY_STANDARD.initialDelayMs,
    },
    removeOnComplete: {
      age: 3600,
    },
    removeOnFail: {
      age: 86400,
    },
  },
};

/**
 * Queue 4: Brief Queue
 * Source: Completion gate (parallel merge) → Target: Compiler (Agent 5)
 * Concurrency: 20 (brief compilation, fast)
 * Priority: By priority_score DESC
 * Note: This queue merges output from both Agent 3 and Agent 4
 */
export const BRIEF_QUEUE_CONFIG: QueueConfig = {
  queueName: 'brief-queue',
  description: 'Brief Compiler (Agent 5) — Merges research and carriers into brief',
  concurrency: 20,
  retryConfig: RETRY_BRIEF,
  priority: true,
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_BRIEF.attempts,
    backoff: {
      type: 'exponential',
      delay: RETRY_BRIEF.initialDelayMs,
    },
    removeOnComplete: {
      age: 3600,
    },
    removeOnFail: {
      age: 86400,
    },
  },
};

/**
 * Queue 5: Call Queue
 * Source: Compiler (Agent 5) → Target: Voice Agent (Agent 6)
 * Concurrency: 100 (Retell supports concurrent calls, throughput bottleneck)
 * Priority: By estimated_margin DESC (higher profit loads called first)
 * Retries: NONE (voice calls are not idempotent)
 */
export const CALL_QUEUE_CONFIG: QueueConfig = {
  queueName: 'call-queue',
  description: 'Voice Agent (Agent 6) via Retell AI — Makes outbound calls',
  concurrency: 100,
  retryConfig: RETRY_NO_RETRY,
  priority: true,
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_NO_RETRY.attempts,
    removeOnComplete: {
      age: 86400, // Keep call queue records longer for audit
    },
    removeOnFail: {
      age: 604800, // 7 days for failed calls
    },
  },
};

/**
 * Queue 6: Dispatch Queue
 * Source: Voice Agent (Agent 6) → Target: Dispatcher (Agent 7)
 * Concurrency: 10 (TMS writes, lower to prevent conflicts)
 * Priority: By profit DESC
 */
export const DISPATCH_QUEUE_CONFIG: QueueConfig = {
  queueName: 'dispatch-queue',
  description: 'Dispatcher (Agent 7) — Creates load in TMS, assigns carrier',
  concurrency: 10,
  retryConfig: RETRY_STANDARD,
  priority: true,
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_STANDARD.attempts,
    backoff: {
      type: 'exponential',
      delay: RETRY_STANDARD.initialDelayMs,
    },
    removeOnComplete: {
      age: 604800, // 7 days
    },
    removeOnFail: {
      age: 604800,
    },
  },
};

/**
 * Queue 7: Feedback Queue
 * Source: Dispatcher (Agent 7) → Target: Feedback Agent
 * Concurrency: 5 (low throughput, post-delivery, non-urgent)
 * Priority: FIFO (process in order)
 */
export const FEEDBACK_QUEUE_CONFIG: QueueConfig = {
  queueName: 'feedback-queue',
  description: 'Feedback Agent — Post-delivery analysis and learning loop',
  concurrency: 5,
  retryConfig: RETRY_LONG_BACKOFF,
  priority: false, // FIFO, no priority
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_LONG_BACKOFF.attempts,
    backoff: {
      type: 'exponential',
      delay: RETRY_LONG_BACKOFF.initialDelayMs,
    },
    removeOnComplete: {
      age: 604800,
    },
    removeOnFail: {
      age: 604800,
    },
  },
};

/**
 * Queue 8: Callback Queue
 * Source: Voice Agent (Agent 6) → Target: Voice Agent (Agent 6)
 * Concurrency: 20 (scheduled callbacks, can overlap)
 * Priority: By scheduled_time (earlier times first)
 * Delayable: YES (jobs scheduled for specific times)
 */
export const CALLBACK_QUEUE_CONFIG: QueueConfig = {
  queueName: 'callback-queue',
  description: 'Callback Handler — Schedules follow-up calls with Agent 6',
  concurrency: 20,
  retryConfig: RETRY_NO_RETRY,
  priority: true,
  delayable: true, // Critical: supports delayed execution
  defaultJobOptions: {
    attempts: RETRY_NO_RETRY.attempts,
    removeOnComplete: {
      age: 604800,
    },
    removeOnFail: {
      age: 604800,
    },
  },
};

/**
 * Queue 9: Escalation Queue
 * Source: Any agent → Target: Notification service
 * Concurrency: 5 (notifications, low priority)
 * Priority: By urgency
 */
export const ESCALATION_QUEUE_CONFIG: QueueConfig = {
  queueName: 'escalation-queue',
  description: 'Escalation Handler — Alerts for stuck/failed loads',
  concurrency: 5,
  retryConfig: RETRY_STANDARD,
  priority: true,
  delayable: false,
  defaultJobOptions: {
    attempts: RETRY_STANDARD.attempts,
    backoff: {
      type: 'exponential',
      delay: RETRY_STANDARD.initialDelayMs,
    },
    removeOnComplete: {
      age: 604800,
    },
    removeOnFail: {
      age: 604800,
    },
  },
};

/**
 * All queue configurations keyed by queue name.
 * Use this for bulk queue initialization.
 */
export const ALL_QUEUE_CONFIGS: Record<string, QueueConfig> = {
  [QUALIFY_QUEUE_CONFIG.queueName]: QUALIFY_QUEUE_CONFIG,
  [RESEARCH_QUEUE_CONFIG.queueName]: RESEARCH_QUEUE_CONFIG,
  [MATCH_QUEUE_CONFIG.queueName]: MATCH_QUEUE_CONFIG,
  [BRIEF_QUEUE_CONFIG.queueName]: BRIEF_QUEUE_CONFIG,
  [CALL_QUEUE_CONFIG.queueName]: CALL_QUEUE_CONFIG,
  [DISPATCH_QUEUE_CONFIG.queueName]: DISPATCH_QUEUE_CONFIG,
  [FEEDBACK_QUEUE_CONFIG.queueName]: FEEDBACK_QUEUE_CONFIG,
  [CALLBACK_QUEUE_CONFIG.queueName]: CALLBACK_QUEUE_CONFIG,
  [ESCALATION_QUEUE_CONFIG.queueName]: ESCALATION_QUEUE_CONFIG,
};

/**
 * Gets queue configuration by queue name.
 *
 * @param queueName - Name of the queue
 * @returns Queue configuration or undefined if not found
 */
export function getQueueConfig(queueName: string): QueueConfig | undefined {
  return ALL_QUEUE_CONFIGS[queueName];
}

/**
 * Gets all queue names in order of execution.
 *
 * @returns Array of queue names in pipeline order
 */
export function getQueuesByOrder(): string[] {
  return [
    QUALIFY_QUEUE_CONFIG.queueName,
    RESEARCH_QUEUE_CONFIG.queueName,
    MATCH_QUEUE_CONFIG.queueName,
    BRIEF_QUEUE_CONFIG.queueName,
    CALL_QUEUE_CONFIG.queueName,
    DISPATCH_QUEUE_CONFIG.queueName,
    FEEDBACK_QUEUE_CONFIG.queueName,
    CALLBACK_QUEUE_CONFIG.queueName,
    ESCALATION_QUEUE_CONFIG.queueName,
  ];
}

/**
 * Converts a RetryConfig to a BullMQ-compatible backoff object.
 *
 * @param retryConfig - Retry configuration
 * @returns BullMQ backoff object
 */
export function getBackoffConfig(
  retryConfig: RetryConfig
): { type: 'exponential' | 'fixed'; delay: number } {
  return {
    type: retryConfig.backoffMultiplier > 1 ? 'exponential' : 'fixed',
    delay: retryConfig.initialDelayMs,
  };
}

/**
 * Total concurrency across all queues.
 * Useful for capacity planning and monitoring.
 */
export function getTotalConcurrency(): number {
  return Object.values(ALL_QUEUE_CONFIGS).reduce(
    (sum, config) => sum + config.concurrency,
    0
  );
}

/**
 * Gets concurrency for a specific queue.
 *
 * @param queueName - Name of the queue
 * @returns Concurrency limit or undefined if queue not found
 */
export function getConcurrency(queueName: string): number | undefined {
  return ALL_QUEUE_CONFIGS[queueName]?.concurrency;
}
