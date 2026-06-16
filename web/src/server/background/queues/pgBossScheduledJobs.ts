import { QueueName } from "@langfuse/shared/src/server";
import type { WorkHandler } from "pg-boss";
import {
  ensurePgBossSchedules,
  logger,
  PG_BOSS_SCHEDULE_DEFINITIONS,
  registerPgBossWorker,
  type PgBossJobEnvelope,
  type PgBossScheduleDefinition,
} from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";

type EventJobData = PgBossJobEnvelope<Record<string, unknown>>;

// ═══════════════════════════════════════════════════════════════════════
// Event-driven processor registration
// ═══════════════════════════════════════════════════════════════════════

export const registerPgBossEventProcessor = async <
  TPayload extends Record<string, unknown> = Record<string, unknown>,
>(
  queueName: QueueName,
  handler: WorkHandler<PgBossJobEnvelope<TPayload>>,
  options: { localConcurrency?: number; pollingIntervalSeconds?: number } = {},
): Promise<void> => {
  await registerPgBossWorker<PgBossJobEnvelope<TPayload>>(
    queueName,
    {
      localConcurrency: options.localConcurrency ?? 1,
      pollingIntervalSeconds: options.pollingIntervalSeconds ?? 1,
    },
    handler,
  );

  logger.info("pg-boss event processor registered", {
    queueName,
    localConcurrency: options.localConcurrency ?? 1,
  });
};

// ═══════════════════════════════════════════════════════════════════════
// Cron / scheduled processor registration
// ═══════════════════════════════════════════════════════════════════════

const scheduleByQueueName = new Map<QueueName, PgBossScheduleDefinition>(
  PG_BOSS_SCHEDULE_DEFINITIONS.map((definition) => [
    definition.queueName,
    definition,
  ]),
);

export const getEnabledPgBossSchedules = (): PgBossScheduleDefinition[] => {
  if (env.LITEFUSE_PG_BOSS_ENABLED !== "true") return [];

  const schedules: PgBossScheduleDefinition[] = [];
  const add = (queueName: QueueName) => {
    const schedule = scheduleByQueueName.get(queueName);
    if (schedule) schedules.push(schedule);
  };

  if (env.QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED === "true")
    add(QueueName.PostHogIntegrationQueue);

  if (env.QUEUE_CONSUMER_MIXPANEL_INTEGRATION_QUEUE_IS_ENABLED === "true")
    add(QueueName.MixpanelIntegrationQueue);

  if (env.QUEUE_CONSUMER_BLOB_STORAGE_INTEGRATION_QUEUE_IS_ENABLED === "true")
    add(QueueName.BlobStorageIntegrationQueue);

  if (env.LITEFUSE_S3_CORE_DATA_EXPORT_IS_ENABLED === "true")
    add(QueueName.CoreDataS3ExportQueue);

  if (env.QUEUE_CONSUMER_DEAD_LETTER_RETRY_QUEUE_IS_ENABLED === "true")
    add(QueueName.DeadLetterRetryQueue);

  return schedules;
};

/**
 * Register a pg-boss worker for a cron/scheduled queue.
 *
 * Accepts a native pg-boss WorkHandler (no toBullJob adapter).
 * The handler receives batches of pg-boss jobs whose data field
 * carries the PgBossJobEnvelope shape.
 */
export const registerPgBossScheduledProcessor = async (
  queueName: QueueName,
  handler: WorkHandler<EventJobData>,
  options: { localConcurrency?: number } = {},
): Promise<void> => {
  await registerPgBossWorker<EventJobData>(
    queueName,
    {
      localConcurrency: options.localConcurrency ?? 1,
      pollingIntervalSeconds: 2,
    },
    handler,
  );
};

/**
 * Boot: ensure pg-boss schedules exist and register a worker
 * for each enabled cron queue.
 */
export const startPgBossScheduledJobs = async (
  processors: Partial<Record<QueueName, WorkHandler<EventJobData>>>,
): Promise<void> => {
  const schedules = getEnabledPgBossSchedules();

  if (schedules.length === 0) {
    logger.info("No pg-boss schedules enabled");
    return;
  }

  await ensurePgBossSchedules(schedules);

  for (const schedule of schedules) {
    const handler = processors[schedule.queueName];
    if (!handler) {
      logger.warn("No pg-boss scheduled processor registered", {
        queueName: schedule.queueName,
      });
      continue;
    }
    await registerPgBossScheduledProcessor(schedule.queueName, handler);
  }

  logger.info("pg-boss schedules started", {
    schedules: schedules.map((s) => ({
      queueName: s.queueName,
      cron: s.cron,
      key: s.key,
    })),
  });
};
