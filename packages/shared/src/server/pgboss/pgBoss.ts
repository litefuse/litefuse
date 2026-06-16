import type { PgBoss } from "pg-boss";
import { randomUUID } from "node:crypto";
import type {
  QueueResult,
  Schedule,
  ScheduleOptions,
  SendOptions,
  WorkHandler,
  WorkOptions,
} from "pg-boss";
import { env } from "../../env";
import { logger } from "../logger";
import { QueueJobs, QueueName } from "../queues";
import { derivePgBossJobId } from "./pgBossJobId";
import type { PgBossQueueConfig } from "./pgBossQueue";
import {
  getAllPgBossQueueNames,
  getPgBossQueueConfig,
} from "./pgBossQueueDefinitions";

export type PgBossScheduleDefinition = {
  queueName: QueueName;
  jobName: QueueJobs;
  cron: string;
  key: string;
  data?: Record<string, unknown>;
  queueOptions: PgBossQueueConfig["queueOptions"];
  scheduleOptions?: Omit<ScheduleOptions, "key" | "tz">;
};

export const PG_BOSS_SCHEDULE_DEFINITIONS = [
  {
    queueName: QueueName.PostHogIntegrationQueue,
    jobName: QueueJobs.PostHogIntegrationJob,
    cron: "30 * * * *",
    key: "posthog-integration-hourly",
    data: {},
    queueOptions: getPgBossQueueConfig(QueueName.PostHogIntegrationQueue)
      .queueOptions,
  },
  {
    queueName: QueueName.MixpanelIntegrationQueue,
    jobName: QueueJobs.MixpanelIntegrationJob,
    cron: "30 * * * *",
    key: "mixpanel-integration-hourly",
    data: {},
    queueOptions: getPgBossQueueConfig(QueueName.MixpanelIntegrationQueue)
      .queueOptions,
  },
  {
    queueName: QueueName.BlobStorageIntegrationQueue,
    jobName: QueueJobs.BlobStorageIntegrationJob,
    cron: "20 * * * *",
    key: "blob-storage-integration-hourly",
    data: {},
    queueOptions: getPgBossQueueConfig(QueueName.BlobStorageIntegrationQueue)
      .queueOptions,
  },
  {
    queueName: QueueName.CoreDataS3ExportQueue,
    jobName: QueueJobs.CoreDataS3ExportJob,
    cron: "15 3 * * *",
    key: "core-data-s3-export-daily",
    data: {},
    queueOptions: getPgBossQueueConfig(QueueName.CoreDataS3ExportQueue)
      .queueOptions,
  },
  {
    queueName: QueueName.DeadLetterRetryQueue,
    jobName: QueueJobs.DeadLetterRetryJob,
    cron: "*/10 * * * *",
    key: "dead-letter-retry-10-minutely",
    data: {},
    queueOptions: getPgBossQueueConfig(QueueName.DeadLetterRetryQueue)
      .queueOptions,
  },
] satisfies PgBossScheduleDefinition[];

declare global {
  var pgBossGlobal: Promise<PgBoss> | undefined;
}

const getDatabaseUrl = () => {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to initialize pg-boss");
  }
  return databaseUrl;
};

let PgBossClass: typeof PgBoss | null = null;

const getPgBossClass = async (): Promise<typeof PgBoss> => {
  if (!PgBossClass) {
    // Dynamic import — pg-boss is ESM-only, can't be require()d from CJS
    PgBossClass = (await import("pg-boss")).PgBoss;
  }
  return PgBossClass;
};

const createPgBoss = async () => {
  const PgBossCtor = await getPgBossClass();
  const boss = new PgBossCtor({
    connectionString: getDatabaseUrl(),
    schema: env.LITEFUSE_PG_BOSS_SCHEMA,
    migrate: env.LITEFUSE_PG_BOSS_MIGRATE === "true",
    createSchema: env.LITEFUSE_PG_BOSS_MIGRATE === "true",
    schedule: true,
    max: env.LITEFUSE_PG_BOSS_POOL_MAX,
    connectionTimeoutMillis: env.LITEFUSE_PG_BOSS_CONNECTION_TIMEOUT_MS,
    application_name: "litefuse-pg-boss",
  });

  boss.on("error", (error) => {
    logger.error("pg-boss error", error);
  });
  boss.on("warning", (warning) => {
    logger.warn("pg-boss warning", warning);
  });

  return boss;
};

let startPromise: Promise<PgBoss> | null = null;

export const getPgBoss = async (): Promise<PgBoss> => {
  if (env.LITEFUSE_PG_BOSS_ENABLED !== "true") {
    throw new Error("pg-boss is disabled via LITEFUSE_PG_BOSS_ENABLED");
  }

  // Cache the promise, not the result — prevents a race where two callers
  // both pass the if-check before either has awaited createPgBoss.
  if (!globalThis.pgBossGlobal) {
    globalThis.pgBossGlobal = createPgBoss();
  }

  return globalThis.pgBossGlobal;
};

export const startPgBoss = async (): Promise<PgBoss> => {
  const boss = await getPgBoss();
  if (!startPromise) {
    startPromise = boss.start();
  }
  await startPromise;
  return boss;
};

export const stopPgBoss = async (
  options: { graceful?: boolean; timeout?: number } = {},
): Promise<void> => {
  if (!globalThis.pgBossGlobal) return;

  try {
    const boss = await globalThis.pgBossGlobal;
    await boss.stop({
      graceful: options.graceful ?? true,
      timeout: options.timeout ?? 30_000,
    });
  } catch (error) {
    // createPgBoss may have failed — the instance was never created.
    logger.error("Error stopping pg-boss", error);
  } finally {
    globalThis.pgBossGlobal = undefined;
    startPromise = null;
  }
};

export const ensurePgBossSchedule = async (
  definition: PgBossScheduleDefinition,
): Promise<void> => {
  const boss = await startPgBoss();

  await boss.createQueue(definition.queueName, definition.queueOptions);
  await boss.schedule(
    definition.queueName,
    definition.cron,
    {
      id: definition.key,
      name: definition.jobName,
      timestamp: new Date().toISOString(),
      payload: definition.data ?? {},
    },
    {
      ...definition.queueOptions,
      ...definition.scheduleOptions,
      key: definition.key,
      tz: env.LITEFUSE_PG_BOSS_SCHEDULE_TZ,
    },
  );
};

export const ensurePgBossSchedules = async (
  definitions: readonly PgBossScheduleDefinition[],
): Promise<void> => {
  await Promise.all(
    definitions.map((definition) => ensurePgBossSchedule(definition)),
  );
};

/**
 * Queue options for the event-driven TraceUpsert queue. Shared so the
 * worker (startup-time registration) and the web (lazy ensure on first
 * enqueue) use the same shape.
 */
export const PG_BOSS_TRACE_UPSERT_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.TraceUpsert).queueOptions;

/**
 * Delete-queue options. The four delete pipelines (trace / score /
 * dataset / project) used to live on BullMQ; we moved them to pg-boss
 * so the ingestion side has fewer Redis touchpoints. Retry policy
 * matches the prior BullMQ defaults closely (2 attempts, 30s backoff,
 * exponential). Expire windows are generous enough for the biggest
 * blocking deletes (project deletion can touch every row).
 */
export const PG_BOSS_TRACE_DELETE_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.TraceDelete).queueOptions;

export const PG_BOSS_SCORE_DELETE_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.ScoreDelete).queueOptions;

export const PG_BOSS_DATASET_DELETE_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.DatasetDelete).queueOptions;

export const PG_BOSS_PROJECT_DELETE_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.ProjectDelete).queueOptions;

export const PG_BOSS_LLM_AS_JUDGE_EXECUTION_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.LLMAsJudgeExecution).queueOptions;

export const PG_BOSS_EVAL_EXECUTION_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.EvaluationExecution).queueOptions;

export const PG_BOSS_CREATE_EVAL_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.CreateEvalQueue).queueOptions;

export const PG_BOSS_DATASET_RUN_ITEM_UPSERT_QUEUE_OPTIONS: PgBossScheduleDefinition["queueOptions"] =
  getPgBossQueueConfig(QueueName.DatasetRunItemUpsert).queueOptions;

/**
 * Map from event-driven queue name to its options. Used by
 * `enqueuePgBossJob` to lazy-create the queue on the producer side if
 * the worker hasn't registered it yet (e.g. web running standalone in
 * dev, or worker booting after web).
 */
const PG_BOSS_EVENT_QUEUE_OPTIONS: Partial<
  Record<QueueName, PgBossScheduleDefinition["queueOptions"]>
> = {
  [QueueName.TraceUpsert]: PG_BOSS_TRACE_UPSERT_QUEUE_OPTIONS,
  [QueueName.TraceDelete]: PG_BOSS_TRACE_DELETE_QUEUE_OPTIONS,
  [QueueName.ScoreDelete]: PG_BOSS_SCORE_DELETE_QUEUE_OPTIONS,
  [QueueName.DatasetDelete]: PG_BOSS_DATASET_DELETE_QUEUE_OPTIONS,
  [QueueName.ProjectDelete]: PG_BOSS_PROJECT_DELETE_QUEUE_OPTIONS,
  [QueueName.LLMAsJudgeExecution]: PG_BOSS_LLM_AS_JUDGE_EXECUTION_QUEUE_OPTIONS,
  [QueueName.EvaluationExecution]: PG_BOSS_EVAL_EXECUTION_QUEUE_OPTIONS,
  [QueueName.EvaluationExecutionSecondaryQueue]:
    PG_BOSS_EVAL_EXECUTION_QUEUE_OPTIONS,
  [QueueName.CreateEvalQueue]: PG_BOSS_CREATE_EVAL_QUEUE_OPTIONS,
  [QueueName.DatasetRunItemUpsert]:
    PG_BOSS_DATASET_RUN_ITEM_UPSERT_QUEUE_OPTIONS,
  [QueueName.ExperimentCreate]: getPgBossQueueConfig(QueueName.ExperimentCreate)
    .queueOptions,
};

/**
 * Ensure an event-driven (non-cron) pg-boss queue exists with the
 * given queue options. Idempotent.
 *
 * Used for queues fed by `enqueuePgBossJob` (e.g. TraceUpsert) — the
 * worker needs the queue registered before `boss.work(...)` will pick
 * up jobs.
 */
export const ensurePgBossEventQueue = async (
  queueName: QueueName,
  queueOptions: PgBossScheduleDefinition["queueOptions"],
): Promise<void> => {
  const boss = await startPgBoss();
  await boss.createQueue(queueName, queueOptions);
};

export const registerPgBossWorker = async <ReqData extends object>(
  queueName: QueueName,
  options: WorkOptions,
  handler: WorkHandler<ReqData>,
): Promise<string> => {
  const boss = await startPgBoss();
  return boss.work<ReqData>(queueName, options, handler);
};

export const getPgBossAdminSnapshot = async (
  queueNames: QueueName[] = getAllPgBossQueueNames(),
): Promise<{
  queues: (QueueResult | null)[];
  schedules: Schedule[];
}> => {
  const boss = await startPgBoss();
  const [queues, schedules] = await Promise.all([
    Promise.all(queueNames.map((queueName) => boss.getQueue(queueName))),
    boss.getSchedules(),
  ]);

  return { queues, schedules };
};

export const retryPgBossJob = async (queueName: string, jobIds: string[]) => {
  const boss = await startPgBoss();
  return boss.retry(queueName, jobIds);
};

export const cancelPgBossJob = async (queueName: string, jobIds: string[]) => {
  const boss = await startPgBoss();
  return boss.cancel(queueName, jobIds);
};

export const deletePgBossJob = async (queueName: string, jobIds: string[]) => {
  const boss = await startPgBoss();
  return boss.deleteJob(queueName, jobIds);
};

export const unschedulePgBossJob = async (queueName: string, key: string) => {
  const boss = await startPgBoss();
  return boss.unschedule(queueName, key);
};

// In-process cache so we don't round-trip to PG on every enqueue.
const ensuredEventQueues = new Set<string>();

export const enqueuePgBossJob = async (
  queueName: QueueName,
  jobName: QueueJobs,
  data: Record<string, unknown> = {},
  options: SendOptions = {},
): Promise<string | null> => {
  const boss = await startPgBoss();
  const explicitId = options.id;
  const jobId = derivePgBossJobId(queueName, options, randomUUID());

  // Lazy-ensure event-driven queues exist before send. pg-boss requires
  // the queue to be created via `createQueue` first; in the upstream
  // worker-only layout that happened on startup. Now that web also
  // produces (TraceUpsert from IngestionService), and web may run
  // without a co-located worker (dev, or worker not booted yet), do an
  // idempotent createQueue here on first send per process.
  const eventOpts = PG_BOSS_EVENT_QUEUE_OPTIONS[queueName];
  if (eventOpts && !ensuredEventQueues.has(queueName)) {
    await boss.createQueue(queueName, eventOpts);
    ensuredEventQueues.add(queueName);
  }

  const queuedJobId = await boss.send(
    queueName,
    {
      id: jobId,
      name: jobName,
      timestamp: new Date().toISOString(),
      payload: data,
    },
    {
      ...options,
      id: jobId,
    },
  );

  if (queuedJobId) {
    return queuedJobId;
  }

  if (explicitId) {
    const existing = await boss.getJobById(queueName, explicitId);
    if (existing) return existing.id;
  }

  if (options.singletonKey) {
    const existing = await boss.findJobs(queueName, {
      key: options.singletonKey,
    });
    if (existing[0]) return existing[0].id;
  }

  return null;
};
