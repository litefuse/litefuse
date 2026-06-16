import "./initialize";

import express from "express";
import cors from "cors";
import * as middlewares from "./middlewares";
import api from "./api";
import MessageResponse from "./interfaces/MessageResponse";

require("dotenv").config();

import {
  evalJobCreatorQueueProcessor,
  evalJobDatasetCreatorQueueProcessor,
  evalJobExecutorQueueProcessorBuilder,
  evalJobTraceCreatorQueueProcessor,
  llmAsJudgeExecutionQueueProcessor,
} from "./queues/evalQueue";
import { batchExportQueueProcessor } from "./queues/batchExportQueue";
import { onShutdown } from "./utils/shutdown";
import helmet from "helmet";
import { WorkerManager } from "./queues/workerManager";
import {
  CoreDataS3ExportQueue,
  PostHogIntegrationQueue,
  MixpanelIntegrationQueue,
  QueueName,
  logger,
  BlobStorageIntegrationQueue,
  DeadLetterRetryQueue,
  IngestionQueue,
  OtelIngestionQueue,
  TraceUpsertQueue,
  EventPropagationQueue,
} from "@langfuse/shared/src/server";
import { env } from "./env";
import { ingestionQueueProcessorBuilder } from "./queues/ingestionQueue";
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
import {
  blobStorageIntegrationProcessingProcessor,
  blobStorageIntegrationProcessor,
} from "./queues/blobStorageIntegrationQueue";
import { coreDataS3ExportProcessor } from "./queues/coreDataS3ExportQueue";
import { batchActionQueueProcessor } from "./queues/batchActionQueue";
import { scoreDeleteProcessor } from "./queues/scoreDelete";
import { DlqRetryService } from "./services/dlq/dlqRetryService";
import { entityChangeQueueProcessor } from "./queues/entityChangeQueue";
import { webhookProcessor } from "./queues/webhooks";
import { datasetDeleteProcessor } from "./queues/datasetDelete";
import { otelIngestionQueueProcessor } from "./queues/otelIngestionQueue";
import { eventPropagationProcessor } from "./queues/eventPropagationQueue";
import { notificationQueueProcessor } from "./queues/notificationQueue";
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
import { BatchProjectBlobCleaner } from "./features/batch-project-blob-cleaner";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.get<{}, MessageResponse>("/", (req, res) => {
  res.json({
    message: "Langfuse Worker API 🚀",
  });
});

app.use("/api", api);

app.use(middlewares.notFound);
app.use(middlewares.errorHandler);

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

if (env.QUEUE_CONSUMER_TRACE_UPSERT_QUEUE_IS_ENABLED === "true") {
  // Register workers for all trace upsert queue shards
  const traceUpsertShardNames = TraceUpsertQueue.getShardNames();
  traceUpsertShardNames.forEach((shardName) => {
    WorkerManager.register(
      shardName as QueueName,
      evalJobTraceCreatorQueueProcessor,
      {
        concurrency: env.LITEFUSE_TRACE_UPSERT_WORKER_CONCURRENCY,
      },
    );
  });
}

if (env.QUEUE_CONSUMER_CREATE_EVAL_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(
    QueueName.CreateEvalQueue,
    evalJobCreatorQueueProcessor,
    {
      concurrency: env.LITEFUSE_EVAL_CREATOR_WORKER_CONCURRENCY,
      limiter: {
        // Process at most `max` jobs per `duration` milliseconds globally
        max: env.LITEFUSE_EVAL_CREATOR_WORKER_CONCURRENCY,
        duration: env.LITEFUSE_EVAL_CREATOR_LIMITER_DURATION,
      },
    },
  );
}

if (env.LITEFUSE_S3_CORE_DATA_EXPORT_IS_ENABLED === "true") {
  // Instantiate the queue to trigger scheduled jobs
  CoreDataS3ExportQueue.getInstance();
  WorkerManager.register(
    QueueName.CoreDataS3ExportQueue,
    coreDataS3ExportProcessor,
  );
}

if (env.QUEUE_CONSUMER_TRACE_DELETE_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(QueueName.TraceDelete, traceDeleteProcessor, {
    concurrency: env.LITEFUSE_TRACE_DELETE_CONCURRENCY,
    // Same configuration as EvaluationExecution or
    // BlobStorageIntegrationProcessingQueue queue, see detailed comment there
    maxStalledCount: 3,
    lockDuration: 60000, // 60 seconds
    stalledInterval: 120000, // 120 seconds
    limiter: {
      // Process at most `max` delete jobs per 2 min
      max: env.LITEFUSE_TRACE_DELETE_CONCURRENCY,
      duration: env.LITEFUSE_DORIS_TRACE_DELETION_CONCURRENCY_DURATION_MS,
    },
  });
}

if (env.QUEUE_CONSUMER_SCORE_DELETE_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(QueueName.ScoreDelete, scoreDeleteProcessor, {
    concurrency: env.LITEFUSE_SCORE_DELETE_CONCURRENCY,
    limiter: {
      // Process at most `max` delete jobs per 15 seconds
      max: env.LITEFUSE_SCORE_DELETE_CONCURRENCY,
      duration: env.LITEFUSE_DORIS_TRACE_DELETION_CONCURRENCY_DURATION_MS,
    },
  });
}

if (env.QUEUE_CONSUMER_DATASET_DELETE_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(QueueName.DatasetDelete, datasetDeleteProcessor, {
    concurrency: env.LITEFUSE_DATASET_DELETE_CONCURRENCY,
    limiter: {
      max: env.LITEFUSE_DATASET_DELETE_CONCURRENCY,
      duration: env.LITEFUSE_DORIS_DATASET_DELETION_CONCURRENCY_DURATION_MS,
    },
  });
}

if (env.QUEUE_CONSUMER_PROJECT_DELETE_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(QueueName.ProjectDelete, projectDeleteProcessor, {
    concurrency: env.LITEFUSE_PROJECT_DELETE_CONCURRENCY,
    limiter: {
      // Process at most `max` delete jobs per LITEFUSE_DORIS_PROJECT_DELETION_CONCURRENCY_DURATION_MS (default 10 min)
      max: env.LITEFUSE_PROJECT_DELETE_CONCURRENCY,
      duration: env.LITEFUSE_DORIS_PROJECT_DELETION_CONCURRENCY_DURATION_MS,
    },
  });
}

if (env.QUEUE_CONSUMER_DATASET_RUN_ITEM_UPSERT_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(
    QueueName.DatasetRunItemUpsert,
    evalJobDatasetCreatorQueueProcessor,
    {
      concurrency: env.LITEFUSE_EVAL_CREATOR_WORKER_CONCURRENCY,
    },
  );
}

if (env.QUEUE_CONSUMER_EVAL_EXECUTION_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(
    QueueName.EvaluationExecution,
    evalJobExecutorQueueProcessorBuilder(true, QueueName.EvaluationExecution),
    {
      concurrency: env.LITEFUSE_EVAL_EXECUTION_WORKER_CONCURRENCY,
      // The default lockDuration is 30s and the lockRenewTime 1/2 of that.
      // We set it to 60s to reduce the number of lock renewals and also be less sensitive to high CPU wait times.
      // We also update the stalledInterval check to 120s from 30s default to perform the check less frequently.
      // Finally, we set the maxStalledCount to 3 (default 1) to perform repeated attempts on stalled jobs.
      lockDuration: 60000, // 60 seconds
      stalledInterval: 120000, // 120 seconds
      maxStalledCount: 3,
    },
  );

  // LLM-as-Judge execution for observation-level evals (uses same env flag as trace evals)
  WorkerManager.register(
    QueueName.LLMAsJudgeExecution,
    llmAsJudgeExecutionQueueProcessor,
    {
      concurrency: env.LITEFUSE_EVAL_EXECUTION_WORKER_CONCURRENCY,
      lockDuration: 60000,
      stalledInterval: 120000,
      maxStalledCount: 3,
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
      concurrency:
        env.LITEFUSE_EVAL_EXECUTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY,
      lockDuration: 60000, // 60 seconds
      stalledInterval: 120000, // 120 seconds
      maxStalledCount: 3,
    },
  );
}

if (env.QUEUE_CONSUMER_BATCH_EXPORT_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(QueueName.BatchExport, batchExportQueueProcessor, {
    concurrency: 1, // only 1 job at a time
    limiter: {
      // execute 1 batch export in 5 seconds to avoid overloading the DB
      max: 1,
      duration: 5_000,
    },
  });
}

if (env.QUEUE_CONSUMER_BATCH_ACTION_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(
    QueueName.BatchActionQueue,
    batchActionQueueProcessor,
    {
      concurrency: 1, // only 1 job at a time
      limiter: {
        max: 1,
        duration: 5_000,
      },
    },
  );
}

if (env.QUEUE_CONSUMER_OTEL_INGESTION_QUEUE_IS_ENABLED === "true") {
  // Register workers for all ingestion queue shards
  const shardNames = OtelIngestionQueue.getShardNames();
  shardNames.forEach((shardName) => {
    WorkerManager.register(
      shardName as QueueName,
      otelIngestionQueueProcessor,
      {
        concurrency: env.LITEFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY,
      },
    );
  });
}

if (env.QUEUE_CONSUMER_INGESTION_QUEUE_IS_ENABLED === "true") {
  // Register workers for all ingestion queue shards
  const shardNames = IngestionQueue.getShardNames();
  shardNames.forEach((shardName) => {
    WorkerManager.register(
      shardName as QueueName,
      ingestionQueueProcessorBuilder(true), // this might redirect to secondary queue
      {
        concurrency: env.LITEFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY,
      },
    );
  });
}

if (env.QUEUE_CONSUMER_INGESTION_SECONDARY_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(
    QueueName.IngestionSecondaryQueue,
    ingestionQueueProcessorBuilder(false),
    {
      concurrency:
        env.LITEFUSE_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY,
    },
  );
}

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
  // Instantiate the queue to trigger scheduled jobs
  PostHogIntegrationQueue.getInstance();

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
      limiter: {
        // Process at most one PostHog job globally per 10s.
        max: 1,
        duration: 10_000,
      },
    },
  );
}

if (env.QUEUE_CONSUMER_MIXPANEL_INTEGRATION_QUEUE_IS_ENABLED === "true") {
  // Instantiate the queue to trigger scheduled jobs
  MixpanelIntegrationQueue.getInstance();

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
      limiter: {
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
  // Instantiate the queue to trigger scheduled jobs
  BlobStorageIntegrationQueue.getInstance();

  WorkerManager.register(
    QueueName.BlobStorageIntegrationQueue,
    blobStorageIntegrationProcessor,
    {
      concurrency: 1,
    },
  );

  WorkerManager.register(
    QueueName.BlobStorageIntegrationProcessingQueue,
    blobStorageIntegrationProcessingProcessor,
    {
      concurrency: 1,
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

if (env.QUEUE_CONSUMER_DEAD_LETTER_RETRY_QUEUE_IS_ENABLED === "true") {
  // Instantiate the queue to trigger scheduled jobs
  DeadLetterRetryQueue.getInstance();

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

if (
  env.QUEUE_CONSUMER_EVENT_PROPAGATION_QUEUE_IS_ENABLED === "true" &&
  env.LITEFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE === "true"
) {
  // Instantiate the queue to trigger scheduled jobs
  EventPropagationQueue.getInstance();

  WorkerManager.register(
    QueueName.EventPropagationQueue,
    eventPropagationProcessor,
    {
      concurrency: 1,
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

// Batch project cleaners for bulk deletion of data
export const batchProjectCleaners: BatchProjectCleaner[] = [];

if (env.LITEFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true") {
  for (const table of BATCH_DELETION_TABLES) {
    // Only start the events_full cleaner when the events table experiment is
    // enabled (gate carries over from the upstream V4 transition; events_core
    // / events tables no longer appear in BATCH_DELETION_TABLES for this fork).
    if (
      table !== "events_full" ||
      env.LITEFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE === "true"
    ) {
      const cleaner = new BatchProjectCleaner(table);
      batchProjectCleaners.push(cleaner);
      cleaner.start();
    }
  }
}

// Batch data retention cleaners for bulk deletion of expired data
export const batchDataRetentionCleaners: BatchDataRetentionCleaner[] = [];

if (env.LITEFUSE_BATCH_DATA_RETENTION_CLEANER_ENABLED === "true") {
  for (const table of BATCH_DATA_RETENTION_TABLES) {
    // Only start the events_full cleaner when the events table experiment is
    // enabled (see note above).
    if (
      table !== "events_full" ||
      env.LITEFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE === "true"
    ) {
      const cleaner = new BatchDataRetentionCleaner(table);
      batchDataRetentionCleaners.push(cleaner);
      cleaner.start();
    }
  }
}

// Media retention cleaner for media files and blob storage
export let mediaRetentionCleaner: MediaRetentionCleaner | null = null;

if (env.LITEFUSE_BATCH_DATA_RETENTION_CLEANER_ENABLED === "true") {
  mediaRetentionCleaner = new MediaRetentionCleaner();
  mediaRetentionCleaner.start();
}

// Batch project media cleaner for S3 media cleanup of soft-deleted projects
export let batchProjectMediaCleaner: BatchProjectMediaCleaner | null = null;

if (
  env.LITEFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true" &&
  env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET
) {
  batchProjectMediaCleaner = new BatchProjectMediaCleaner();
  batchProjectMediaCleaner.start();
}

// Batch project blob cleaner for ingestion event S3/Doris cleanup of soft-deleted projects
export let batchProjectBlobCleaner: BatchProjectBlobCleaner | null = null;

if (
  env.LITEFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true" &&
  env.LITEFUSE_ENABLE_BLOB_STORAGE_FILE_LOG === "true"
) {
  batchProjectBlobCleaner = new BatchProjectBlobCleaner();
  batchProjectBlobCleaner.start();
}

// Batch trace deletion cleaner for supplementary trace deletion
export let batchTraceDeletionCleaner: BatchTraceDeletionCleaner | null = null;

if (env.LITEFUSE_BATCH_TRACE_DELETION_CLEANER_ENABLED === "true") {
  batchTraceDeletionCleaner = new BatchTraceDeletionCleaner();
  batchTraceDeletionCleaner.start();
}

process.on("SIGINT", () => onShutdown("SIGINT"));
process.on("SIGTERM", () => onShutdown("SIGTERM"));

export default app;
