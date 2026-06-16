import { QueueName, type TQueueJobTypes } from "../queues";
import { PgBossQueue, type PgBossQueueConfig } from "./pgBossQueue";

/** Extract payload type for a given QueueName from TQueueJobTypes */
type QueuePayload<Q extends QueueName> = Q extends keyof TQueueJobTypes
  ? TQueueJobTypes[Q] extends { payload: infer P }
    ? P extends Record<string, unknown>
      ? P
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════════════
// Queue Configurations — retry policy, default options per queue
// Mirrors the defaultJobOptions from the Redis Queue singleton classes.
// ═══════════════════════════════════════════════════════════════════════

// ── Default policies ─────────────────────────────────────────────────

const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;
const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

const MEDIUM_RETRY = {
  retryLimit: 4, // BullMQ attempts: 5
  retryDelay: 5,
  retryBackoff: true,
  deleteAfterSeconds: SEVEN_DAYS_IN_SECONDS,
} as const;

const LOW_RETRY = {
  retryLimit: 2, // BullMQ attempts: 3
  retryDelay: 5,
  retryBackoff: true,
  deleteAfterSeconds: SEVEN_DAYS_IN_SECONDS,
} as const;

const MEDIUM_RETRY_FAST_BACKOFF = {
  retryLimit: 9, // BullMQ attempts: 10
  retryDelay: 1,
  retryBackoff: true,
  deleteAfterSeconds: SEVEN_DAYS_IN_SECONDS,
} as const;

const SCHEDULED_SINGLETON = {
  policy: "singleton" as const,
  retryLimit: 4, // BullMQ attempts: 5
  retryDelay: 5,
  retryBackoff: true,
  deleteAfterSeconds: ONE_DAY_IN_SECONDS,
} as const;

const DEFAULT_WORK_OPTIONS = {
  localConcurrency: 1,
  pollingIntervalSeconds: 2,
  batchSize: 1,
} as const;

// ── All queue configs ───────────────────────────────────────────────

export const PG_BOSS_QUEUE_CONFIGS: Record<QueueName, PgBossQueueConfig> = {
  // ── Core ingestion & eval trigger ────────────────────────────────
  [QueueName.TraceUpsert]: {
    queueName: QueueName.TraceUpsert,
    queueOptions: {
      ...MEDIUM_RETRY,
      expireInSeconds: 15 * 60,
    },
    defaultSendOptions: { startAfter: 30 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS, batchSize: 5 },
  },

  [QueueName.TraceDelete]: {
    queueName: QueueName.TraceDelete,
    queueOptions: {
      ...MEDIUM_RETRY,
      expireInSeconds: 60 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.ProjectDelete]: {
    queueName: QueueName.ProjectDelete,
    queueOptions: {
      ...MEDIUM_RETRY,
      expireInSeconds: 2 * 60 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.ScoreDelete]: {
    queueName: QueueName.ScoreDelete,
    queueOptions: {
      ...LOW_RETRY,
      expireInSeconds: 30 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.DatasetDelete]: {
    queueName: QueueName.DatasetDelete,
    queueOptions: {
      ...LOW_RETRY,
      expireInSeconds: 30 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  // ── Evaluation execution ─────────────────────────────────────────

  [QueueName.EvaluationExecution]: {
    queueName: QueueName.EvaluationExecution,
    queueOptions: {
      ...MEDIUM_RETRY_FAST_BACKOFF,
      expireInSeconds: 30 * 60,
    },
    defaultWorkOptions: {
      ...DEFAULT_WORK_OPTIONS,
      localConcurrency: 5,
      batchSize: 1,
    },
  },

  [QueueName.EvaluationExecutionSecondaryQueue]: {
    queueName: QueueName.EvaluationExecutionSecondaryQueue,
    queueOptions: {
      ...MEDIUM_RETRY_FAST_BACKOFF,
      expireInSeconds: 30 * 60,
    },
    defaultWorkOptions: {
      ...DEFAULT_WORK_OPTIONS,
      localConcurrency: 3,
      batchSize: 1,
    },
  },

  [QueueName.LLMAsJudgeExecution]: {
    queueName: QueueName.LLMAsJudgeExecution,
    queueOptions: {
      ...MEDIUM_RETRY_FAST_BACKOFF,
      expireInSeconds: 30 * 60,
    },
    defaultWorkOptions: {
      ...DEFAULT_WORK_OPTIONS,
      localConcurrency: 5,
      batchSize: 1,
    },
  },

  [QueueName.CreateEvalQueue]: {
    queueName: QueueName.CreateEvalQueue,
    queueOptions: {
      ...MEDIUM_RETRY,
      expireInSeconds: 15 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.DatasetRunItemUpsert]: {
    queueName: QueueName.DatasetRunItemUpsert,
    queueOptions: {
      ...MEDIUM_RETRY,
      expireInSeconds: 15 * 60,
    },
    defaultSendOptions: { startAfter: 15 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS, batchSize: 5 },
  },

  // ── Batch operations ─────────────────────────────────────────────

  [QueueName.BatchActionQueue]: {
    queueName: QueueName.BatchActionQueue,
    queueOptions: {
      retryLimit: 9, // BullMQ attempts: 10
      retryDelay: 5,
      retryBackoff: true,
      deleteAfterSeconds: SEVEN_DAYS_IN_SECONDS,
      expireInSeconds: 60 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  // ── Scheduled / cron queues ──────────────────────────────────────

  [QueueName.CoreDataS3ExportQueue]: {
    queueName: QueueName.CoreDataS3ExportQueue,
    queueOptions: { ...SCHEDULED_SINGLETON, expireInSeconds: 2 * 60 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.DeadLetterRetryQueue]: {
    queueName: QueueName.DeadLetterRetryQueue,
    queueOptions: { ...SCHEDULED_SINGLETON, expireInSeconds: 10 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  // ── Integrations ─────────────────────────────────────────────────

  [QueueName.PostHogIntegrationQueue]: {
    queueName: QueueName.PostHogIntegrationQueue,
    queueOptions: { ...SCHEDULED_SINGLETON, expireInSeconds: 30 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.PostHogIntegrationProcessingQueue]: {
    queueName: QueueName.PostHogIntegrationProcessingQueue,
    queueOptions: { ...MEDIUM_RETRY, expireInSeconds: 60 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.MixpanelIntegrationQueue]: {
    queueName: QueueName.MixpanelIntegrationQueue,
    queueOptions: { ...SCHEDULED_SINGLETON, expireInSeconds: 30 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.MixpanelIntegrationProcessingQueue]: {
    queueName: QueueName.MixpanelIntegrationProcessingQueue,
    queueOptions: { ...MEDIUM_RETRY, expireInSeconds: 60 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.BlobStorageIntegrationQueue]: {
    queueName: QueueName.BlobStorageIntegrationQueue,
    queueOptions: { ...SCHEDULED_SINGLETON, expireInSeconds: 30 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.BlobStorageIntegrationProcessingQueue]: {
    queueName: QueueName.BlobStorageIntegrationProcessingQueue,
    queueOptions: { ...MEDIUM_RETRY, expireInSeconds: 60 * 60 },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  // ── Webhook / notification / event ────────────────────────────────

  [QueueName.WebhookQueue]: {
    queueName: QueueName.WebhookQueue,
    queueOptions: {
      ...MEDIUM_RETRY,
      expireInSeconds: 10 * 60,
    },
    defaultWorkOptions: {
      ...DEFAULT_WORK_OPTIONS,
      localConcurrency: 5,
      batchSize: 1,
    },
  },

  [QueueName.EntityChangeQueue]: {
    queueName: QueueName.EntityChangeQueue,
    queueOptions: {
      ...MEDIUM_RETRY,
      expireInSeconds: 10 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },

  [QueueName.NotificationQueue]: {
    queueName: QueueName.NotificationQueue,
    queueOptions: {
      retryLimit: 4, // BullMQ attempts: 5
      retryDelay: 3,
      retryBackoff: true,
      deleteAfterSeconds: SEVEN_DAYS_IN_SECONDS,
      expireInSeconds: 5 * 60,
    },
    defaultWorkOptions: {
      ...DEFAULT_WORK_OPTIONS,
      localConcurrency: 5,
    },
  },

  [QueueName.ExperimentCreate]: {
    queueName: QueueName.ExperimentCreate,
    queueOptions: {
      retryLimit: 9, // BullMQ attempts: 10
      retryDelay: 10,
      retryBackoff: true,
      deleteAfterSeconds: SEVEN_DAYS_IN_SECONDS,
      expireInSeconds: 30 * 60,
    },
    defaultWorkOptions: { ...DEFAULT_WORK_OPTIONS },
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Singleton instances — lazy-initialized, one per QueueName
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: Omit<PgBossQueueConfig, "queueName"> = {
  queueOptions: {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    deleteAfterSeconds: 7 * 24 * 60 * 60,
  },
  defaultWorkOptions: {
    localConcurrency: 1,
    pollingIntervalSeconds: 2,
    batchSize: 1,
  },
};

const instances = new Map<QueueName, PgBossQueue>();

/**
 * Get (or create) the singleton PgBossQueue for a given QueueName.
 * The return type is narrowed to the payload type from TQueueJobTypes,
 * so send/insertBulk payload arguments are type-checked per queue.
 */
export function getPgBossQueue<QName extends QueueName>(
  queueName: QName,
): PgBossQueue<QueuePayload<QName>> {
  const existing = instances.get(queueName);
  if (existing) return existing as PgBossQueue<QueuePayload<QName>>;

  const config: PgBossQueueConfig = PG_BOSS_QUEUE_CONFIGS[queueName]
    ? (PG_BOSS_QUEUE_CONFIGS[queueName] as PgBossQueueConfig)
    : { queueName, ...DEFAULT_CONFIG };

  const queue = new PgBossQueue<QueuePayload<QName>>(config);
  instances.set(queueName, queue);
  return queue;
}

/**
 * Create a standalone PgBossQueue with a custom config.
 * Does **not** register in the singleton cache — the caller owns the instance.
 */
export function createPgBossQueue(
  queueName: QueueName,
  overrides?: Partial<PgBossQueueConfig>,
): PgBossQueue {
  const config: PgBossQueueConfig = {
    queueName,
    queueOptions: { ...DEFAULT_CONFIG.queueOptions },
    defaultWorkOptions: { ...DEFAULT_CONFIG.defaultWorkOptions },
    ...overrides,
  };
  return new PgBossQueue(config);
}

/**
 * Get all registered QueueNames for iteration.
 */
export function getAllPgBossQueueNames(): QueueName[] {
  return Object.keys(PG_BOSS_QUEUE_CONFIGS) as QueueName[];
}

/**
 * Check if a queue is configured in pg-boss.
 */
export function hasPgBossQueueConfig(queueName: QueueName): boolean {
  return queueName in PG_BOSS_QUEUE_CONFIGS;
}

export function getPgBossQueueConfig(queueName: QueueName): PgBossQueueConfig {
  return (
    PG_BOSS_QUEUE_CONFIGS[queueName] ?? {
      queueName,
      ...DEFAULT_CONFIG,
    }
  );
}
