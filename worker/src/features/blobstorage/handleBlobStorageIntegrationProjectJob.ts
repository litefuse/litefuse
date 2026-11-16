import { pipeline, type Readable } from "stream";
import { Job } from "bullmq";
import { prisma } from "@langfuse/shared/src/db";
import {
  QueueName,
  TQueueJobTypes,
  logger,
  StorageService,
  StorageServiceFactory,
  streamTransformations,
  getObservationsForBlobStorageExport,
  getTracesForBlobStorageExport,
  getScoresForBlobStorageExport,
  getEventsForBlobStorageExport,
  getCurrentSpan,
  BlobStorageIntegrationProcessingQueue,
  queryDoris,
  QueueJobs,
} from "@langfuse/shared/src/server";
import {
  BlobStorageIntegrationType,
  BlobStorageIntegrationFileType,
  BlobStorageExportMode,
} from "@langfuse/shared";
import { decrypt } from "@langfuse/shared/encryption";
import { randomUUID } from "crypto";
import { env } from "../../env";
import { tableFor } from "@langfuse/shared/src/server";
import type { BlobExportTable } from "./parquetSchema";
import { uploadParquetExport } from "./uploadParquetExport";

const getMinTimestampForExport = async (
  projectId: string,
  lastSyncAt: Date | null,
  exportMode: BlobStorageExportMode,
  exportStartDate: Date | null,
): Promise<Date> => {
  // If we have a lastSyncAt, use it (this is for subsequent exports)
  if (lastSyncAt) {
    return lastSyncAt;
  }

  // For first export, use the export mode to determine start date
  switch (exportMode) {
    case BlobStorageExportMode.FULL_HISTORY:
      // Query Doris for the actual minimum timestamp from traces, observations, and scores tables
      try {
        // OTel-only spans: traces and observations are now a single
        // span table — one spans SELECT replaces the two-branch UNION
        // ALL over traces / observations. scores stays untouched.
        const result = await queryDoris<{ min_timestamp: number | null }>({
          query: `
              SELECT min(UNIX_TIMESTAMP(ts)) * 1000 as min_timestamp
              FROM (
                SELECT min(start_time) as ts
                FROM ${tableFor(projectId, "spans")}
                WHERE project_id = {projectId: String}

                UNION ALL

                SELECT min(timestamp) as ts
                FROM scores
                WHERE project_id = {projectId: String}
              ) t
              WHERE ts IS NOT NULL -- Ignore empty tables
            `,
          params: { projectId },
        });

        // Extract the minimum timestamp
        logger.info(
          `[BLOB INTEGRATION] Doris min_timestamp for project ${projectId}: ${result[0]?.min_timestamp}, type: ${typeof result[0]?.min_timestamp}`,
        );
        const minTimestampValue = Number(result[0]?.min_timestamp);

        if (minTimestampValue && minTimestampValue > 0) {
          const date = new Date(minTimestampValue);
          logger.info(
            `[BLOB INTEGRATION] Created Date from min_timestamp for project ${projectId}: ${date}, isValid: ${!isNaN(date.getTime())}, getTime: ${date.getTime()}`,
          );
          return date;
        }

        // If no data exists, skip to current time to avoid infinite catch-up loop
        logger.info(
          `[BLOB INTEGRATION] No historical data found for project ${projectId}, using current time`,
        );
        return new Date();
      } catch (error) {
        logger.error(
          `[BLOB INTEGRATION] Error querying Doris for minimum timestamp for project ${projectId}`,
          error,
        );
        throw new Error(`Failed to fetch minimum timestamp: ${error}`);
      }
    case BlobStorageExportMode.FROM_TODAY:
    case BlobStorageExportMode.FROM_CUSTOM_DATE:
      return exportStartDate || new Date(); // Use export start date or current time as fallback
    default:
      // eslint-disable-next-line no-case-declarations
      const _exhaustiveCheck: never = exportMode;
      throw new Error(`Invalid export mode: ${exportMode}`);
  }
};

/**
 * Get the frequency interval in milliseconds for a given export frequency.
 * This is used to chunk historic exports into manageable time windows.
 */
const getFrequencyIntervalMs = (frequency: string): number => {
  switch (frequency) {
    case "hourly":
      return 60 * 60 * 1000; // 1 hour
    case "daily":
      return 24 * 60 * 60 * 1000; // 1 day
    case "weekly":
      return 7 * 24 * 60 * 60 * 1000; // 1 week
    default:
      throw new Error(`Unsupported export frequency: ${frequency}`);
  }
};

const getFileTypeProperties = (fileType: BlobStorageIntegrationFileType) => {
  switch (fileType) {
    case BlobStorageIntegrationFileType.JSON:
      return {
        contentType: "application/json; charset=utf-8",
        extension: "json",
      };
    case BlobStorageIntegrationFileType.CSV:
      return {
        contentType: "text/csv; charset=utf-8",
        extension: "csv",
      };
    case BlobStorageIntegrationFileType.JSONL:
      return {
        contentType: "application/x-ndjson; charset=utf-8",
        extension: "jsonl",
      };
    case BlobStorageIntegrationFileType.PARQUET:
      return {
        contentType: "application/vnd.apache.parquet",
        extension: "parquet",
      };
    default:
      // eslint-disable-next-line no-case-declarations
      const _exhaustiveCheck: never = fileType;
      throw new Error(`Unsupported file type: ${fileType}`);
  }
};

const exportQueries = {
  traces: getTracesForBlobStorageExport,
  observations: getObservationsForBlobStorageExport,
  scores: getScoresForBlobStorageExport,
  observations_v2: getEventsForBlobStorageExport,
} satisfies Record<BlobExportTable, unknown>;

const processBlobStorageExport = async (config: {
  projectId: string;
  minTimestamp: Date;
  maxTimestamp: Date;
  bucketName: string;
  endpoint: string | null;
  region: string;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  prefix?: string;
  forcePathStyle?: boolean;
  type: BlobStorageIntegrationType;
  table: BlobExportTable;
  fileType: BlobStorageIntegrationFileType;
}) => {
  logger.info(
    `[BLOB INTEGRATION] Processing ${config.table} export for project ${config.projectId}`,
  );

  // Initialize the storage service
  // KMS SSE is not supported for this integration.
  const storageService: StorageService = StorageServiceFactory.getInstance({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucketName: config.bucketName,
    endpoint: config.endpoint ?? undefined,
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? false,
    awsSse: undefined,
    awsSseKmsKeyId: undefined,
    useAzureBlob: config.type === BlobStorageIntegrationType.AZURE_BLOB_STORAGE,
  });

  try {
    const blobStorageProps = getFileTypeProperties(config.fileType);

    const timestampIso = config.maxTimestamp.toISOString().replace(/:/g, "-");
    const timestamp =
      config.fileType === "PARQUET"
        ? timestampIso
        : timestampIso.substring(0, 19);
    const filePath = `${config.prefix ?? ""}${config.projectId}/${config.table}/${timestamp}.${blobStorageProps.extension}`;

    const upload = (data: Readable) =>
      storageService.uploadFileBuffered({
        fileName: filePath,
        fileType: blobStorageProps.contentType,
        data,
        // 100 MiB parts keep large files within S3's 10,000-part limit.
        partSizeBytes: 100 * 1024 * 1024,
      });
    const readRows = (options?: { parquet: boolean; signal: AbortSignal }) =>
      exportQueries[config.table](
        config.projectId,
        config.minTimestamp,
        config.maxTimestamp,
        options,
      );

    if (config.fileType === "PARQUET") {
      await uploadParquetExport(
        config.table,
        (signal) => readRows({ parquet: true, signal }),
        upload,
      );
    } else {
      const fileStream = pipeline(
        readRows(),
        streamTransformations[config.fileType](),
        (err) => {
          if (err) {
            logger.error(
              "[BLOB INTEGRATION] Getting data from DB for blob storage integration failed: ",
              err,
            );
          }
        },
      );
      await upload(fileStream);
    }

    logger.info(
      `[BLOB INTEGRATION] Successfully exported ${config.table} records for project ${config.projectId}`,
    );
  } catch (error) {
    logger.error(
      `[BLOB INTEGRATION] Error exporting ${config.table} for project ${config.projectId}`,
      error,
    );
    throw error;
  }
};

export const handleBlobStorageIntegrationProjectJob = async (
  job: Job<TQueueJobTypes[QueueName.BlobStorageIntegrationProcessingQueue]>,
) => {
  const { projectId } = job.data.payload;

  const span = getCurrentSpan();
  if (span) {
    span.setAttribute("messaging.bullmq.job.input.jobId", job.data.id);
    span.setAttribute("messaging.bullmq.job.input.projectId", projectId);
  }

  logger.info(
    `[BLOB INTEGRATION] Processing blob storage integration for project ${projectId}`,
  );

  const blobStorageIntegration = await prisma.blobStorageIntegration.findUnique(
    {
      where: {
        projectId,
      },
    },
  );

  if (!blobStorageIntegration) {
    logger.warn(
      `[BLOB INTEGRATION] Blob storage integration not found for project ${projectId}`,
    );
    return;
  }
  if (!blobStorageIntegration.enabled) {
    logger.info(
      `[BLOB INTEGRATION] Blob storage integration is disabled for project ${projectId}`,
    );
    return;
  }
  const parquet = blobStorageIntegration.fileType === "PARQUET";
  const updateWhere = {
    projectId,
    ...(parquet
      ? {
          lastSyncAt: blobStorageIntegration.lastSyncAt,
          updatedAt: blobStorageIntegration.updatedAt,
        }
      : {}),
  };

  // Sync between lastSyncAt and now - 30 minutes
  // Cap the export to one frequency period to enable chunked historic exports
  try {
    const minTimestamp = await getMinTimestampForExport(
      projectId,
      blobStorageIntegration.lastSyncAt,
      blobStorageIntegration.exportMode,
      blobStorageIntegration.exportStartDate,
    );

    logger.info(
      `[BLOB INTEGRATION] Calculated minTimestamp for project ${projectId}: ${minTimestamp}, isValid: ${!isNaN(minTimestamp.getTime())}, getTime: ${minTimestamp.getTime()}, exportMode: ${blobStorageIntegration.exportMode}, lastSyncAt: ${blobStorageIntegration.lastSyncAt}, exportStartDate: ${blobStorageIntegration.exportStartDate}`,
    );

    const now =
      parquet && job.data.timestamp ? new Date(job.data.timestamp) : new Date();
    const uncappedMaxTimestamp = new Date(now.getTime() - 30 * 60 * 1000); // 30-minute lag buffer
    const frequencyIntervalMs = getFrequencyIntervalMs(
      blobStorageIntegration.exportFrequency,
    );

    // Cap maxTimestamp to one frequency period ahead of minTimestamp
    // This ensures large historic exports are broken into manageable chunks
    const maxTimestamp = new Date(
      Math.min(
        minTimestamp.getTime() + frequencyIntervalMs,
        uncappedMaxTimestamp.getTime(),
      ),
    );

    logger.info(
      `[BLOB INTEGRATION] Calculated maxTimestamp for project ${projectId}: ${maxTimestamp}, isValid: ${!isNaN(maxTimestamp.getTime())}, getTime: ${maxTimestamp.getTime()}, frequencyIntervalMs: ${frequencyIntervalMs}`,
    );

    // Skip export if the time window is empty or invalid
    if (minTimestamp >= maxTimestamp) {
      logger.info(
        `[BLOB INTEGRATION] Skipping export for project ${projectId}: time window is empty (min: ${minTimestamp.toISOString()}, max: ${maxTimestamp.toISOString()})`,
      );
      // A Parquet run with no eligible window must keep its start position.
      if (parquet) return;
      // Update lastSyncAt to now so the integration doesn't get stuck in a catch-up loop
      const nowForSkip = new Date();
      await prisma.blobStorageIntegration.update({
        where: { projectId },
        data: {
          lastSyncAt: nowForSkip,
          nextSyncAt: new Date(nowForSkip.getTime() + frequencyIntervalMs),
        },
      });
      return;
    }

    // Process the export based on the integration configuration
    const executionConfig = {
      projectId,
      minTimestamp,
      maxTimestamp,
      bucketName: blobStorageIntegration.bucketName,
      endpoint: blobStorageIntegration.endpoint,
      region: blobStorageIntegration.region || "auto",
      accessKeyId: blobStorageIntegration.accessKeyId || undefined,
      secretAccessKey: blobStorageIntegration.secretAccessKey
        ? decrypt(blobStorageIntegration.secretAccessKey)
        : undefined,
      prefix: blobStorageIntegration.prefix || undefined,
      forcePathStyle: blobStorageIntegration.forcePathStyle || undefined,
      type: blobStorageIntegration.type,
      fileType: blobStorageIntegration.fileType,
    };

    // Check if this project should only export traces (legacy behavior via env var)
    const isTraceOnlyProject =
      env.LITEFUSE_BLOB_STORAGE_EXPORT_TRACE_ONLY_PROJECT_IDS.includes(
        projectId,
      );

    if (isTraceOnlyProject) {
      // Only process traces table for projects in the trace-only list (legacy behavior)
      logger.info(
        `[BLOB INTEGRATION] Project ${projectId} is configured for trace-only export via env var, skipping observations, scores, and events`,
      );
      await processBlobStorageExport({ ...executionConfig, table: "traces" });
    } else {
      const tables: BlobExportTable[] = ["scores"];

      // Traces and observations - for TRACES_OBSERVATIONS and TRACES_OBSERVATIONS_EVENTS
      if (
        blobStorageIntegration.exportSource === "TRACES_OBSERVATIONS" ||
        blobStorageIntegration.exportSource === "TRACES_OBSERVATIONS_EVENTS"
      ) {
        tables.push("traces", "observations");
      }

      // Events - for EVENTS and TRACES_OBSERVATIONS_EVENTS
      // events are stored in the observations_v2 directory in blob storage
      if (
        blobStorageIntegration.exportSource === "EVENTS" ||
        blobStorageIntegration.exportSource === "TRACES_OBSERVATIONS_EVENTS"
      ) {
        tables.push("observations_v2");
      }

      const processTable = (table: BlobExportTable) =>
        processBlobStorageExport({ ...executionConfig, table });
      if (parquet) {
        for (const table of tables) await processTable(table);
      } else {
        await Promise.all(tables.map(processTable));
      }
    }

    // Determine if we've caught up with present-day data
    const caughtUp = maxTimestamp.getTime() >= uncappedMaxTimestamp.getTime();

    let nextSyncAt: Date;
    if (caughtUp) {
      // Normal mode: schedule for the next frequency period
      nextSyncAt = new Date(maxTimestamp.getTime() + frequencyIntervalMs);
      logger.info(
        `[BLOB INTEGRATION] Caught up with exports for project ${projectId}. Next sync at ${nextSyncAt.toISOString()}`,
      );
    } else {
      // Catch-up mode: schedule next chunk immediately
      nextSyncAt = new Date();
      logger.info(
        `[BLOB INTEGRATION] Still catching up for project ${projectId}. Scheduling next chunk immediately (processed up to ${maxTimestamp.toISOString()})`,
      );
    }

    // Update integration after successful processing
    const updated = await prisma.blobStorageIntegration.updateMany({
      where: updateWhere,
      data: {
        lastSyncAt: maxTimestamp,
        nextSyncAt,
        lastError: null,
        lastErrorAt: null,
      },
    });
    if (updated.count === 0) return;

    // If still catching up, immediately queue the next chunk job
    if (!caughtUp) {
      const queue = BlobStorageIntegrationProcessingQueue.getInstance();
      if (queue) {
        const jobId = `${projectId}-${maxTimestamp.toISOString()}`;
        await queue.add(
          QueueJobs.BlobStorageIntegrationProcessingJob,
          {
            id: randomUUID(),
            name: QueueJobs.BlobStorageIntegrationProcessingJob,
            timestamp: new Date(),
            payload: { projectId },
          },
          { jobId, removeOnFail: true },
        );
        logger.info(
          `[BLOB INTEGRATION] Queued next catch-up chunk for project ${projectId} with jobId ${jobId}`,
        );
      }
    }

    logger.info(
      `[BLOB INTEGRATION] Successfully processed blob storage integration for project ${projectId}`,
    );
  } catch (error) {
    try {
      const errorMessage = extractStorageErrorMessage(error);
      await prisma.blobStorageIntegration.updateMany({
        where: updateWhere,
        data: {
          lastError: errorMessage,
          lastErrorAt: new Date(),
        },
      });
    } catch (persistError) {
      logger.error(
        `[BLOB INTEGRATION] Failed to persist blob storage error for project ${projectId}`,
        persistError,
      );
    }
    logger.error(
      `[BLOB INTEGRATION] Error processing blob storage integration for project ${projectId}`,
      error,
    );
    throw error; // Rethrow to trigger retries
  }
};

function extractStorageErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 1000);

  // handleStorageError wraps SDK errors via { cause: sdkError }
  // Unwrap to get the raw SDK message (S3/Azure/GCS)
  const cause = error.cause;
  if (cause instanceof Error) {
    return cause.message.slice(0, 1000);
  }

  // Fallback: Doris errors or other non-wrapped errors
  return error.message.slice(0, 1000);
}
