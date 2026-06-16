import {
  logger,
  instrumentAsync,
  getPgBossQueue,
  QueueName,
  QueueJobs,
  type PgBossJobEnvelope,
} from "@langfuse/shared/src/server";
import { handleBlobStorageIntegrationSchedule } from "../features/blobstorage/handleBlobStorageIntegrationSchedule";
import { handleBlobStorageIntegrationProjectJob } from "../features/blobstorage/handleBlobStorageIntegrationProjectJob";
import { SpanKind } from "@opentelemetry/api";
import type { WorkHandler } from "pg-boss";

// ── pg-boss native handlers ────────────────────────────────────────

type SchedulePayload = Record<string, never>;
type ProcessingPayload = { projectId: string };

/** Handles the cron trigger — discovers due projects and enqueues per-project jobs. */
export const blobStorageIntegrationScheduleHandler: WorkHandler<
  PgBossJobEnvelope<SchedulePayload>
> = async (_jobs) => {
  logger.info("Executing Blob Storage Integration cron job");
  try {
    await handleBlobStorageIntegrationSchedule();
  } catch (error) {
    logger.error("Error executing BlobStorageIntegrationSchedule", error);
    throw error;
  }
};

/** Handles per-project blob export processing. */
export const blobStorageIntegrationProcessingHandler: WorkHandler<
  PgBossJobEnvelope<ProcessingPayload>
> = async (jobs) => {
  for (const job of jobs) {
    if (job.data.name !== QueueJobs.BlobStorageIntegrationProcessingJob)
      continue;

    await instrumentAsync(
      {
        name: "process blob-storage-project",
        startNewTrace: true,
        spanKind: SpanKind.CONSUMER,
      },
      async () => {
        try {
          await handleBlobStorageIntegrationProjectJob(
            job.data.payload.projectId,
          );
        } catch (error) {
          logger.error(
            "Error executing BlobStorageIntegrationProcessingJob",
            error,
          );
          throw error;
        }
      },
    );
  }
};

/** Register pg-boss workers for the blob storage integration queues. */
export const registerBlobStoragePgBossWorkers = async () => {
  const scheduleQueue = getPgBossQueue(QueueName.BlobStorageIntegrationQueue);
  await scheduleQueue.registerWorker(
    { localConcurrency: 1 },
    blobStorageIntegrationScheduleHandler,
  );

  const processingQueue = getPgBossQueue(
    QueueName.BlobStorageIntegrationProcessingQueue,
  );
  await processingQueue.registerWorker(
    { localConcurrency: 1 },
    blobStorageIntegrationProcessingHandler,
  );

  logger.info("Blob storage integration pg-boss workers registered");
};
