import {
  evalJobCreatorQueueProcessor,
  evalJobDatasetCreatorQueueProcessor,
  evalJobExecutorQueueProcessorBuilder,
  evalJobTraceCreatorQueueProcessor,
  llmAsJudgeExecutionQueueProcessor,
} from "./queues/evalQueue";
import { WorkerManager } from "./queues/workerManager";
import {
  QueueName,
  ensurePgBossSchedules,
  logger,
  stopPgBoss,
  PG_BOSS_TRACE_UPSERT_QUEUE_OPTIONS,
  PG_BOSS_TRACE_DELETE_QUEUE_OPTIONS,
  PG_BOSS_SCORE_DELETE_QUEUE_OPTIONS,
  PG_BOSS_DATASET_DELETE_QUEUE_OPTIONS,
  PG_BOSS_PROJECT_DELETE_QUEUE_OPTIONS,
  PG_BOSS_LLM_AS_JUDGE_EXECUTION_QUEUE_OPTIONS,
  PG_BOSS_EVAL_EXECUTION_QUEUE_OPTIONS,
  PG_BOSS_CREATE_EVAL_QUEUE_OPTIONS,
  PG_BOSS_DATASET_RUN_ITEM_UPSERT_QUEUE_OPTIONS,
} from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";
import { BackgroundMigrationManager } from "./backgroundMigrations/backgroundMigrationManager";
import { prisma } from "@langfuse/shared/src/db";
import { DorisReadSkipCache } from "./utils/dorisReadSkipCache";
import { experimentCreateQueueProcessor } from "./queues/experimentQueue";
import { traceDeleteProcessor } from "./queues/traceDelete";
import { projectDeleteProcessor } from "./queues/projectDelete";
import {
  postHogIntegrationProcessingProcessor,
  postHogIntegrationProcessor,
} from "./queues/postHogIntegrationQueue";
import {
  mixpanelIntegrationProcessingProcessor,
  mixpanelIntegrationProcessor,
} from "./queues/mixpanelIntegrationQueue";
import { registerBlobStoragePgBossWorkers } from "./queues/blobStorageIntegrationQueue";
import { coreDataS3ExportProcessor } from "./queues/coreDataS3ExportQueue";
import { batchActionQueueProcessor } from "./queues/batchActionQueue";
import { scoreDeleteProcessor } from "./queues/scoreDelete";
import { DlqRetryService } from "./services/dlq/dlqRetryService";
import { entityChangeQueueProcessor } from "./queues/entityChangeQueue";
import { webhookProcessor } from "./queues/webhooks";
import { datasetDeleteProcessor } from "./queues/datasetDelete";
import { notificationQueueProcessor } from "./queues/notificationQueue";
import { getEnabledPgBossSchedules } from "./queues/pgBossScheduledJobs";
import {
  BatchProjectCleaner,
  BATCH_DELETION_TABLES,
} from "./features/batch-project-cleaner";
import {
  BatchDataRetentionCleaner,
  BATCH_DATA_RETENTION_TABLES,
} from "./features/batch-data-retention-cleaner";
import { MediaRetentionCleaner } from "./features/media-retention-cleaner";
import { BatchTraceDeletionCleaner } from "./features/batch-trace-deletion-cleaner";
import { BatchProjectMediaCleaner } from "./features/batch-project-media-cleaner";
import { upsertDefaultModelPrices } from "./scripts/upsertDefaultModelPrices";
import { upsertManagedEvaluators } from "./scripts/upsertManagedEvaluators";
import { upsertLangfuseDashboards } from "./scripts/upsertLangfuseDashboards";
import { freeAllTokenizers } from "@langfuse/shared/src/server/tokenisation";

declare global {
  // Next.js dev reloads can evaluate instrumentation more than once.
  // Keep worker registration process-singleton, not module-singleton.
  var langfuseBackgroundProcessingStarted: boolean | undefined;
}

export const batchProjectCleaners: BatchProjectCleaner[] = [];
export const batchDataRetentionCleaners: BatchDataRetentionCleaner[] = [];
export let mediaRetentionCleaner: MediaRetentionCleaner | null = null;
export let batchProjectMediaCleaner: BatchProjectMediaCleaner | null = null;
export let batchTraceDeletionCleaner: BatchTraceDeletionCleaner | null = null;

export const startBackgroundProcessing = () => {
  if (env.LITEFUSE_BACKGROUND_PROCESSING_ENABLED !== "true") {
    logger.info("Background processing disabled");
    return;
  }

  if (globalThis.langfuseBackgroundProcessingStarted) {
    logger.debug("Background processing already started, skipping");
    return;
  }
  globalThis.langfuseBackgroundProcessingStarted = true;

  upsertDefaultModelPrices();
  upsertManagedEvaluators();
  upsertLangfuseDashboards();

  if (env.LITEFUSE_ENABLE_BACKGROUND_MIGRATIONS === "true") {
    // Will start background migrations without blocking the queue workers
    BackgroundMigrationManager.run().catch((err) => {
      logger.error("Error running background migrations", err);
    });
  }

  // Initialize DorisReadSkipCache on container start
  DorisReadSkipCache.getInstance(prisma)
    .initialize()
    .catch((err: Error) => {
      logger.error("Error initializing DorisReadSkipCache", err);
    });

  if (env.LITEFUSE_PG_BOSS_ENABLED === "true") {
    const enabledSchedules = getEnabledPgBossSchedules();

    ensurePgBossSchedules(enabledSchedules).catch((err) => {
      logger.error("Failed to ensure pg-boss schedules", err);
    });
  }

  if (env.QUEUE_CONSUMER_TRACE_UPSERT_QUEUE_IS_ENABLED === "true") {
    // TraceUpsert migrated from BullMQ (sharded by projectId-traceId) to
    // pg-boss event-driven. Producers (IngestionService) call
    // enqueuePgBossJob with singletonKey = `trace-upsert:<projectId>:<traceId>`
    // and a short window so rapid-fire updates to the same trace dedupe
    // into a single eval-trigger job.
    WorkerManager.register(
      QueueName.TraceUpsert,
      evalJobTraceCreatorQueueProcessor as any,
      {
        queueOptions: PG_BOSS_TRACE_UPSERT_QUEUE_OPTIONS,
        localConcurrency: env.LITEFUSE_TRACE_UPSERT_WORKER_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_CREATE_EVAL_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.CreateEvalQueue,
      evalJobCreatorQueueProcessor as any,
      {
        queueOptions: PG_BOSS_CREATE_EVAL_QUEUE_OPTIONS,
        localConcurrency: env.LITEFUSE_EVAL_CREATOR_WORKER_CONCURRENCY,
        rateLimit: {
          max: env.LITEFUSE_EVAL_CREATOR_WORKER_CONCURRENCY,
          duration: env.LITEFUSE_EVAL_CREATOR_LIMITER_DURATION,
        },
      },
    );
  }

  if (env.LITEFUSE_S3_CORE_DATA_EXPORT_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.CoreDataS3ExportQueue,
      coreDataS3ExportProcessor,
    );
  }

  // Postgres metering data export is part of the Enterprise Edition.

  // Trace / Score / Dataset / Project delete: pg-boss event-driven. The
  // per-queue limiter (rate-limit) that BullMQ had is dropped — pg-boss
  // caps throughput via localConcurrency only. If rate-limiting comes
  // back as a need we'll add it on the worker thread / Doris client
  // layer rather than re-introducing BullMQ here.
  if (env.QUEUE_CONSUMER_TRACE_DELETE_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(QueueName.TraceDelete, traceDeleteProcessor as any, {
      queueOptions: PG_BOSS_TRACE_DELETE_QUEUE_OPTIONS,
      localConcurrency: env.LITEFUSE_TRACE_DELETE_CONCURRENCY,
    });
  }

  if (env.QUEUE_CONSUMER_SCORE_DELETE_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(QueueName.ScoreDelete, scoreDeleteProcessor as any, {
      queueOptions: PG_BOSS_SCORE_DELETE_QUEUE_OPTIONS,
      localConcurrency: env.LITEFUSE_SCORE_DELETE_CONCURRENCY,
    });
  }

  if (env.QUEUE_CONSUMER_DATASET_DELETE_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.DatasetDelete,
      datasetDeleteProcessor as any,
      {
        queueOptions: PG_BOSS_DATASET_DELETE_QUEUE_OPTIONS,
        localConcurrency: env.LITEFUSE_DATASET_DELETE_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_PROJECT_DELETE_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.ProjectDelete,
      projectDeleteProcessor as any,
      {
        queueOptions: PG_BOSS_PROJECT_DELETE_QUEUE_OPTIONS,
        localConcurrency: env.LITEFUSE_PROJECT_DELETE_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_DATASET_RUN_ITEM_UPSERT_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.DatasetRunItemUpsert,
      evalJobDatasetCreatorQueueProcessor as any,
      {
        queueOptions: PG_BOSS_DATASET_RUN_ITEM_UPSERT_QUEUE_OPTIONS,
        localConcurrency: env.LITEFUSE_EVAL_CREATOR_WORKER_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_EVAL_EXECUTION_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.EvaluationExecution,
      evalJobExecutorQueueProcessorBuilder(
        true,
        QueueName.EvaluationExecution,
      ) as any,
      {
        queueOptions: PG_BOSS_EVAL_EXECUTION_QUEUE_OPTIONS,
        localConcurrency: env.LITEFUSE_EVAL_EXECUTION_WORKER_CONCURRENCY,
      },
    );

    // LLM-as-Judge execution for observation-level evals (uses same env flag as trace evals)
    WorkerManager.register(
      QueueName.LLMAsJudgeExecution,
      llmAsJudgeExecutionQueueProcessor as any,
      {
        queueOptions: PG_BOSS_LLM_AS_JUDGE_EXECUTION_QUEUE_OPTIONS,
        localConcurrency: env.LITEFUSE_EVAL_EXECUTION_WORKER_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_EVAL_EXECUTION_SECONDARY_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.EvaluationExecutionSecondaryQueue,
      evalJobExecutorQueueProcessorBuilder(
        false,
        QueueName.EvaluationExecutionSecondaryQueue,
      ),
      {
        queueOptions: PG_BOSS_EVAL_EXECUTION_QUEUE_OPTIONS,
        localConcurrency:
          env.LITEFUSE_EVAL_EXECUTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_BATCH_ACTION_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.BatchActionQueue,
      batchActionQueueProcessor,
      {
        concurrency: 1, // only 1 job at a time
        rateLimit: {
          max: 1,
          duration: 5_000,
        },
      },
    );
  }

  // Ingestion / OTel ingestion / secondary ingestion queues removed: web
  // now direct-writes to Doris via processEventBatch +
  // OtelIngestionProcessor.processSpansSync. The worker no longer needs
  // to consume any ingestion queue.

  // Cloud usage metering, spend alerts, and free-tier usage thresholds are
  // Enterprise Edition features and have no queue processors in this build.

  if (env.QUEUE_CONSUMER_EXPERIMENT_CREATE_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.ExperimentCreate,
      experimentCreateQueueProcessor,
      {
        concurrency: env.LITEFUSE_EXPERIMENT_CREATOR_WORKER_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.PostHogIntegrationQueue,
      postHogIntegrationProcessor,
      {
        concurrency: 1,
      },
    );

    WorkerManager.register(
      QueueName.PostHogIntegrationProcessingQueue,
      postHogIntegrationProcessingProcessor,
      {
        concurrency: 1,
        // The default lockDuration is 30s and the lockRenewTime 1/2 of that.
        // We set it to 60s to reduce the number of lock renewals and also be less sensitive to high CPU wait times.
        // We also update the stalledInterval check to 120s from 30s default to perform the check less frequently.
        // Finally, we set the maxStalledCount to 3 (default 1) to perform repeated attempts on stalled jobs.
        lockDuration: 60000, // 60 seconds
        stalledInterval: 120000, // 120 seconds
        maxStalledCount: 3,
        rateLimit: {
          // Process at most one PostHog job globally per 10s.
          max: 1,
          duration: 10_000,
        },
      },
    );
  }

  if (env.QUEUE_CONSUMER_MIXPANEL_INTEGRATION_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.MixpanelIntegrationQueue,
      mixpanelIntegrationProcessor,
      {
        concurrency: 1,
      },
    );

    WorkerManager.register(
      QueueName.MixpanelIntegrationProcessingQueue,
      mixpanelIntegrationProcessingProcessor,
      {
        concurrency: 1,
        rateLimit: {
          // Process at most one Mixpanel job globally per 10s.
          max: 1,
          duration: 10_000,
        },
        // The default lockDuration is 30s and the lockRenewTime 1/2 of that.
        // We set it to 60s to reduce the number of lock renewals and also be less sensitive to high CPU wait times.
        // We also update the stalledInterval check to 120s from 30s default to perform the check less frequently.
        // Finally, we set the maxStalledCount to 3 (default 1) to perform repeated attempts on stalled jobs.
        lockDuration: 60000, // 60 seconds
        stalledInterval: 120000, // 120 seconds
        maxStalledCount: 3,
      },
    );
  }

  if (env.QUEUE_CONSUMER_BLOB_STORAGE_INTEGRATION_QUEUE_IS_ENABLED === "true") {
    // pg-boss: cron schedule is registered via PG_BOSS_SCHEDULE_DEFINITIONS.
    // Workers for both scheduler and processing queues are handled by
    // registerBlobStoragePgBossWorkers (fire-and-forget async).
    registerBlobStoragePgBossWorkers().catch((err) => {
      logger.error("Failed to register blob storage pg-boss workers", err);
    });
  }

  // Data retention is an Enterprise Edition feature; no workers in this build.

  if (env.QUEUE_CONSUMER_DEAD_LETTER_RETRY_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.DeadLetterRetryQueue,
      DlqRetryService.retryDeadLetterQueue,
      {
        concurrency: 1,
      },
    );
  }

  if (env.QUEUE_CONSUMER_WEBHOOK_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(QueueName.WebhookQueue, webhookProcessor, {
      concurrency: env.LITEFUSE_WEBHOOK_QUEUE_PROCESSING_CONCURRENCY,
    });
  }

  if (env.QUEUE_CONSUMER_ENTITY_CHANGE_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.EntityChangeQueue,
      entityChangeQueueProcessor,
      {
        concurrency: env.LITEFUSE_ENTITY_CHANGE_QUEUE_PROCESSING_CONCURRENCY,
      },
    );
  }

  if (env.QUEUE_CONSUMER_NOTIFICATION_QUEUE_IS_ENABLED === "true") {
    WorkerManager.register(
      QueueName.NotificationQueue,
      notificationQueueProcessor,
      {
        concurrency: 5, // Process up to 5 notification jobs concurrently
      },
    );
  }

  if (env.LITEFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true") {
    for (const table of BATCH_DELETION_TABLES) {
      const cleaner = new BatchProjectCleaner(table);
      batchProjectCleaners.push(cleaner);
      cleaner.start();
    }
  }

  if (env.LITEFUSE_BATCH_DATA_RETENTION_CLEANER_ENABLED === "true") {
    for (const table of BATCH_DATA_RETENTION_TABLES) {
      const cleaner = new BatchDataRetentionCleaner(table);
      batchDataRetentionCleaners.push(cleaner);
      cleaner.start();
    }
  }

  if (env.LITEFUSE_BATCH_DATA_RETENTION_CLEANER_ENABLED === "true") {
    mediaRetentionCleaner = new MediaRetentionCleaner();
    mediaRetentionCleaner.start();
  }

  if (
    env.LITEFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true" &&
    env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET
  ) {
    batchProjectMediaCleaner = new BatchProjectMediaCleaner();
    batchProjectMediaCleaner.start();
  }

  // BatchProjectBlobCleaner deleted: ingestion no longer writes to MinIO,
  // so there are no S3 blob refs to clean up after a project is
  // soft-deleted.

  // Batch trace deletion cleaner for supplementary trace deletion
  if (env.LITEFUSE_BATCH_TRACE_DELETION_CLEANER_ENABLED === "true") {
    batchTraceDeletionCleaner = new BatchTraceDeletionCleaner();
    batchTraceDeletionCleaner.start();
  }
};

export const stopBackgroundProcessing = async () => {
  if (!globalThis.langfuseBackgroundProcessingStarted) {
    return;
  }
  globalThis.langfuseBackgroundProcessingStarted = false;

  for (const cleaner of batchProjectCleaners) {
    cleaner.stop();
  }
  batchProjectCleaners.length = 0;

  for (const cleaner of batchDataRetentionCleaners) {
    cleaner.stop();
  }
  batchDataRetentionCleaners.length = 0;

  mediaRetentionCleaner?.stop();
  mediaRetentionCleaner = null;

  batchProjectMediaCleaner?.stop();
  batchProjectMediaCleaner = null;

  batchTraceDeletionCleaner?.stop();
  batchTraceDeletionCleaner = null;

  WorkerManager.close();
  await stopPgBoss({ graceful: false, timeout: 0 });
  await BackgroundMigrationManager.close();
  freeAllTokenizers();

  logger.info("Background processing stopped");
};
