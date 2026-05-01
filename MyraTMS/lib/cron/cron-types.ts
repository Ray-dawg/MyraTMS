/**
 * Myra Logistics — Cron Job Types & Interfaces
 *
 * Type definitions for all cron jobs in the pipeline orchestration backbone.
 * These are the operational heartbeat jobs that keep the pipeline alive.
 *
 * @version 1.0
 * @owner Patrice Penda
 */

/**
 * Configuration for the Scanner Polling Trigger cron job.
 * Runs every 30 seconds to check load boards for new loads.
 */
export interface ScannerPollingConfig {
  /** Interval in milliseconds between polls (default: 30000) */
  pollingInterval: number;

  /** List of load board sources to scan (e.g., 'dat', '123lb', 'truckstop') */
  activeSources: string[];

  /** Maximum number of loads to process in a single poll batch */
  maxBatchSize: number;

  /** Whether to enable deduplication across sources */
  deduplicationEnabled: boolean;

  /** Grace period in hours: skip loads posted before this time */
  minAgeHours: number;
}

/**
 * Result from a single scanner polling cycle.
 */
export interface ScanResult {
  success: boolean;
  timestamp: string;

  /** Total loads found across all sources */
  totalScanned: number;

  /** New loads successfully enqueued to qualify-queue */
  newLoadsEnqueued: number;

  /** Loads skipped due to deduplication */
  duplicatesSkipped: number;

  /** Loads that failed to enqueue */
  enqueueFailed: number;

  /** Per-source breakdown */
  sourceBreakdown: Array<{
    source: string;
    scanned: number;
    new: number;
    duplicates: number;
    errors: number;
  }>;

  /** Any errors that occurred (doesn't prevent other sources from scanning) */
  errors: Array<{
    source: string;
    message: string;
  }>;

  /** Total execution time in milliseconds */
  durationMs: number;
}

/**
 * Configuration for the Stuck Load Detector cron job.
 * Runs every 5 minutes to find loads stalled in a stage.
 */
export interface StuckLoadDetectorConfig {
  /** Interval in milliseconds between checks (default: 300000 = 5 minutes) */
  checkInterval: number;

  /** How long a load can stay in the same stage before being considered stuck (minutes, default: 30) */
  stuckThresholdMinutes: number;

  /** Maximum number of times a load can be re-enqueued before escalating */
  maxRetries: number;

  /** Stages to monitor (exclude terminal stages like 'scored', 'expired', 'disqualified') */
  stagesToMonitor: string[];

  /** Whether to automatically re-enqueue stuck loads */
  autoRetryEnabled: boolean;
}

/**
 * Result from a stuck load detection cycle.
 */
export interface StuckLoadResult {
  success: boolean;
  timestamp: string;

  /** Total number of loads found in stuck state */
  stuckLoadsFound: number;

  /** Loads that were re-enqueued for retry */
  requeued: number;

  /** Loads escalated to escalation-queue (max retries exceeded) */
  escalated: number;

  /** Details of each stuck load action */
  actions: Array<{
    pipelineLoadId: number;
    loadId: string;
    stage: string;
    stuckDurationMinutes: number;
    retryCount: number;
    action: 'requeued' | 'escalated' | 'skipped';
    reason: string;
  }>;

  /** Total execution time in milliseconds */
  durationMs: number;
}

/**
 * Configuration for the Load Expiry Sweep cron job.
 * Runs every 15 minutes to expire loads whose pickup dates have passed.
 */
export interface LoadExpirySweepConfig {
  /** Interval in milliseconds between sweeps (default: 900000 = 15 minutes) */
  sweepInterval: number;

  /** Grace period after pickup date before marking as expired (hours, default: 2) */
  gracePeriodHours: number;

  /** Stages that should NOT be expired (terminal stages) */
  exemptStages: string[];
}

/**
 * Result from a load expiry sweep cycle.
 */
export interface ExpiryResult {
  success: boolean;
  timestamp: string;

  /** Total loads expired in this cycle */
  loadsExpired: number;

  /** IDs of expired loads (for audit trail) */
  expiredLoadIds: number[];

  /** Pending jobs that were cancelled */
  jobsCancelled: number;

  /** Details of actions taken */
  actions: Array<{
    pipelineLoadId: number;
    loadId: string;
    pickupDate: string;
    stage: string;
    jobsCancelledCount: number;
  }>;

  /** Total execution time in milliseconds */
  durationMs: number;
}

/**
 * Configuration for the Dead Letter Sweep cron job.
 * Runs every 10 minutes to process permanently failed jobs.
 */
export interface DeadLetterSweepConfig {
  /** Interval in milliseconds between sweeps (default: 600000 = 10 minutes) */
  sweepInterval: number;

  /** Which queues to monitor */
  queueNames: string[];

  /** Number of failed jobs before triggering a critical alert */
  alertThreshold: number;
}

/**
 * Result from a dead letter sweep cycle.
 */
export interface DeadLetterResult {
  success: boolean;
  timestamp: string;

  /** Total failed jobs found across all queues */
  totalFailedJobs: number;

  /** Jobs moved to dead letter table */
  jobsMoved: number;

  /** Escalation notifications sent */
  notificationsSent: number;

  /** Per-queue breakdown */
  queueBreakdown: Array<{
    queueName: string;
    failedCount: number;
    moved: number;
    notificationsSent: number;
  }>;

  /** Details of each moved job */
  movedJobs: Array<{
    jobId: string;
    queueName: string;
    pipelineLoadId: number | null;
    failureReason: string;
    lastError: string;
    attempts: number;
  }>;

  /** Total execution time in milliseconds */
  durationMs: number;
}

/**
 * Health status of a single cron job.
 */
export interface CronJobHealth {
  jobName: string;
  enabled: boolean;

  /** Last time the job ran */
  lastRunAt: string | null;

  /** Duration of last run in milliseconds */
  lastRunDurationMs: number | null;

  /** Whether the last run succeeded */
  lastRunSucceeded: boolean | null;

  /** Summary of last run results */
  lastRunResult: any | null;

  /** Number of consecutive failures */
  consecutiveFailures: number;

  /** Next scheduled run (ISO timestamp) */
  nextRunAt: string;

  /** Error count in the last hour */
  errorCountLastHour: number;
}

/**
 * Overall cron system health status.
 */
export interface CronHealth {
  healthy: boolean;
  timestamp: string;

  /** Health of each individual cron job */
  jobs: Record<string, CronJobHealth>;

  /** Overall error count in last hour */
  totalErrorsLastHour: number;

  /** Any critical issues */
  criticalIssues: string[];
}

/**
 * Metrics for a single cron job.
 */
export interface CronMetrics {
  jobName: string;

  /** Successful runs */
  successCount: number;

  /** Failed runs */
  failureCount: number;

  /** Average duration of last 10 runs */
  avgDurationMs: number;

  /** Min and max durations */
  minDurationMs: number;
  maxDurationMs: number;

  /** Last 10 run results (for debugging) */
  recentResults: Array<{
    timestamp: string;
    durationMs: number;
    success: boolean;
    resultSummary: any;
  }>;
}

/**
 * Central configuration for the cron scheduler.
 */
export interface CronScheduleConfig {
  /** Enable/disable all crons (master kill switch) */
  enabled: boolean;

  /** Configuration for each cron job */
  scannerPolling: ScannerPollingConfig;
  stuckLoadDetector: StuckLoadDetectorConfig;
  loadExpirySweep: LoadExpirySweepConfig;
  deadLetterSweep: DeadLetterSweepConfig;

  /** Global monitoring configuration */
  monitoring: {
    /** Enable structured logging */
    loggingEnabled: boolean;

    /** Alert thresholds */
    errorRateAlertThreshold: number; // percentage
    consecutiveFailuresAlert: number;
  };
}

/**
 * Reference to an active cron job interval.
 */
export interface CronJobHandle {
  jobName: string;
  intervalId: NodeJS.Timer | null;
}

/**
 * The complete cron schedule manager.
 */
export interface CronSchedule {
  /** Whether the schedule is active */
  isActive: boolean;

  /** Map of job names to their handles */
  jobs: Map<string, CronJobHandle>;

  /** Current configuration */
  config: CronScheduleConfig;

  /** Health of all jobs */
  health: CronHealth;

  /** Metrics for all jobs */
  metrics: Map<string, CronMetrics>;
}

/**
 * Structured log entry for cron operations.
 */
export interface CronLog {
  timestamp: string;
  jobName: string;
  level: 'info' | 'warn' | 'error';
  message: string;

  /** Additional context */
  context: Record<string, any>;

  /** Execution time if applicable */
  durationMs?: number;
}

/**
 * Error that occurred during cron execution.
 */
export interface CronError {
  jobName: string;
  timestamp: string;
  message: string;
  stack?: string;

  /** Whether this error is retryable */
  retryable: boolean;
}
