import {
  BatchActionProcessingEventType,
  CreateEvalQueue,
  EvalExecutionQueue,
  getCurrentSpan,
  logger,
  QueueJobs,
  QueueName,
  TQueueJobTypes,
  traceDeletionProcessor,
} from "@langfuse/shared/src/server";
import {
  BatchActionType,
  BatchActionStatus,
  BatchTableNames,
  ActionId,
  type FilterCondition,
  EvalTargetObject,
} from "@langfuse/shared";
import Decimal from "decimal.js";
import {
  getDatabaseReadStreamPaginated,
  getTraceIdentifierStream,
} from "../database-read-stream/getDatabaseReadStream";
import { env } from "../../env";
import { Job } from "bullmq";
import {
  processAddObservationsToQueue,
  processAddSessionsToQueue,
  processAddTracesToQueue,
} from "./processAddToQueue";
import { prisma } from "@langfuse/shared/src/db";
import { randomUUID } from "node:crypto";
import { processDorisScoreDelete } from "../scores/processDorisScoreDelete";
import { getObservationStream } from "../database-read-stream/observation-stream";
import {
  getEventsStreamForEval,
  getEventsStreamForDataset,
} from "../database-read-stream/event-stream";
import { processAddObservationsToDataset } from "./processAddObservationsToDataset";
import { ObservationAddToDatasetConfigSchema } from "@langfuse/shared";
import { processBatchedObservationEval } from "./processBatchedObservationEval";

const CHUNK_SIZE = 1000;
const MAX_BATCH_ACTION_LOG_LINES = 20;
const convertDatesInFiltersFromStrings = (filters: FilterCondition[]) => {
  return filters.map((f: FilterCondition) =>
    f.type === "datetime" ? { ...f, value: new Date(f.value) } : f,
  );
};

/**
 * ⚠️ All operations must be idempotent. In case of failure, the job should be retried.
 * If it does, chunks that have already been processed might be processed again.
 */
async function processActionChunk(
  actionId: string,
  chunkIds: string[],
  projectId: string,
  targetId?: string,
): Promise<void> {
  try {
    switch (actionId) {
      case "trace-delete":
        await traceDeletionProcessor(projectId, chunkIds, { delayMs: 0 });
        break;

      case "trace-add-to-annotation-queue":
        await processAddTracesToQueue(projectId, chunkIds, targetId as string);
        break;

      case "session-add-to-annotation-queue":
        await processAddSessionsToQueue(
          projectId,
          chunkIds,
          targetId as string,
        );
        break;

      case "observation-add-to-annotation-queue":
        await processAddObservationsToQueue(
          projectId,
          chunkIds,
          targetId as string,
        );
        break;

      case "score-delete":
        await processDorisScoreDelete(projectId, chunkIds);
        break;

      default:
        throw new Error(`Unknown action: ${actionId}`);
    }
  } catch (error) {
    logger.error(`Failed to process chunk`, { error, chunkIds });
    throw error;
  }
}

export type TraceRowForEval = {
  id: string;
  projectId: string;
  timestamp: Date;
};

export type DatasetRunItemRowForEval = {
  id: string;
  projectId: string;
  datasetItemId: string;
  traceId: string;
  observationId: string | null;
};
const assertIsTracesTableRecord = (
  element: unknown,
): element is TraceRowForEval => {
  return (
    typeof element === "object" &&
    element !== null &&
    "id" in element &&
    "projectId" in element &&
    "timestamp" in element
  );
};

const assertIsDatasetRunItemTableRecord = (
  element: unknown,
): element is DatasetRunItemRowForEval => {
  return (
    typeof element === "object" &&
    element !== null &&
    "id" in element &&
    "projectId" in element &&
    "datasetItemId" in element &&
    "traceId" in element &&
    "observationId" in element
  );
};

export const handleBatchActionJob = async (
  batchActionJob: Job<TQueueJobTypes[QueueName.BatchActionQueue]>["data"],
) => {
  const batchActionEvent: BatchActionProcessingEventType =
    batchActionJob.payload;

  const { actionId } = batchActionEvent;

  const span = getCurrentSpan();
  if (span) {
    span.setAttribute(
      "messaging.bullmq.job.input.projectId",
      batchActionEvent.projectId,
    );
    span.setAttribute(
      "messaging.bullmq.job.input.actionId",
      batchActionEvent.actionId,
    );
  }

  if (
    actionId === "trace-delete" ||
    actionId === "trace-add-to-annotation-queue" ||
    actionId === "session-add-to-annotation-queue" ||
    actionId === "observation-add-to-annotation-queue" ||
    actionId === "score-delete"
  ) {
    const { projectId, tableName, query, cutoffCreatedAt, targetId, type } =
      batchActionEvent;

    if (type === BatchActionType.Create && !targetId) {
      throw new Error(`Target ID is required for create action`);
    }

    const dbReadStream =
      actionId === "trace-delete"
        ? await getTraceIdentifierStream({
            projectId: projectId,
            cutoffCreatedAt: new Date(cutoffCreatedAt),
            filter: convertDatesInFiltersFromStrings(query.filter ?? []),
            orderBy: query.orderBy,
            searchQuery: query.searchQuery ?? undefined,
            searchType: query.searchType ?? ["id" as const],
          })
        : tableName === BatchTableNames.Observations
          ? await getObservationStream({
              projectId: projectId,
              cutoffCreatedAt: new Date(cutoffCreatedAt),
              filter: convertDatesInFiltersFromStrings(query.filter ?? []),
              searchQuery: query.searchQuery ?? undefined,
              searchType: query.searchType ?? ["id" as const],
            })
          : await getDatabaseReadStreamPaginated({
              projectId: projectId,
              cutoffCreatedAt: new Date(cutoffCreatedAt),
              filter: convertDatesInFiltersFromStrings(query.filter ?? []),
              orderBy: query.orderBy,
              tableName: tableName as BatchTableNames,
              searchQuery: query.searchQuery ?? undefined,
              searchType: query.searchType ?? ["id" as const],
            });

    // Process stream in database-sized batches
    // 1. Read all records
    const records: any[] = [];
    for await (const record of dbReadStream) {
      if (record?.id) {
        records.push(record);
      }
    }

    // 2. Process in chunks
    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const batch = records.slice(i, i + CHUNK_SIZE);

      await processActionChunk(
        actionId,
        batch.map((r) => r.id),
        projectId,
        targetId,
      );
    }
  } else if (actionId === "eval-create") {
    // if a user wants to apply evals for historic traces or dataset runs, we do this here.
    // 1) we fetch data from the database, 2) we create eval executions in batches, 3) we create eval execution jobs for each batch
    const { projectId, query, targetObject, configId, cutoffCreatedAt } =
      batchActionEvent;

    const config = await prisma.jobConfiguration.findUnique({
      where: {
        id: configId,
        projectId: projectId,
      },
    });

    if (!config) {
      logger.error(
        `Eval config ${configId} not found for project ${projectId}`,
      );
      return;
    }

    const dbReadStream =
      targetObject === EvalTargetObject.TRACE
        ? await getTraceIdentifierStream({
            projectId: projectId,
            cutoffCreatedAt: new Date(cutoffCreatedAt),
            filter: convertDatesInFiltersFromStrings(query.filter ?? []),
            orderBy: query.orderBy,
            searchQuery: query.searchQuery ?? undefined,
            searchType: query.searchType,
            rowLimit: env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT,
          }) // when reading from Doris, we only want to read the necessary identifiers.
        : await getDatabaseReadStreamPaginated({
            projectId: projectId,
            cutoffCreatedAt: new Date(cutoffCreatedAt),
            filter: convertDatesInFiltersFromStrings(query.filter ?? []),
            orderBy: query.orderBy,
            tableName: BatchTableNames.DatasetRunItems,
            rowLimit: env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT,
          });

    const evalCreatorQueue = CreateEvalQueue.getInstance();
    if (!evalCreatorQueue) {
      logger.error("CreateEvalQueue is not initialized");
      return;
    }

    let count = 0;
    for await (const record of dbReadStream) {
      if (
        targetObject === EvalTargetObject.TRACE &&
        assertIsTracesTableRecord(record)
      ) {
        const payload = {
          projectId: record.projectId,
          traceId: record.id,
          configId: configId,
          timestamp: new Date(record.timestamp),
          exactTimestamp: new Date(record.timestamp),
        };

        await evalCreatorQueue.add(QueueJobs.CreateEvalJob, {
          payload,
          id: randomUUID(),
          timestamp: new Date(),
          name: QueueJobs.CreateEvalJob as const,
        });
        count++;
      } else if (
        targetObject === EvalTargetObject.DATASET &&
        assertIsDatasetRunItemTableRecord(record)
      ) {
        const payload = {
          projectId: record.projectId,
          datasetItemId: record.datasetItemId,
          traceId: record.traceId,
          observationId: record.observationId ?? undefined,
          configId: configId,
          //We need to set this to be able to fetch traces from the past. We cannot infer from the dataset run when the trace was created.
          timestamp: new Date("2020-01-01"),
        };

        await evalCreatorQueue.add(
          QueueJobs.CreateEvalJob,
          {
            payload,
            id: randomUUID(),
            timestamp: new Date(),
            name: QueueJobs.CreateEvalJob as const,
          },
          { delay: config.delay },
        );
        count++;
      } else {
        logger.error(
          "Record is not a valid traces table or dataset record",
          record,
        );
      }
    }
    logger.info(
      `Batch action job completed, projectId: ${batchActionJob.payload.projectId}, ${count} elements`,
    );
  } else if (actionId === "observation-add-to-dataset") {
    const {
      projectId,
      query,
      cutoffCreatedAt,
      config,
      batchActionId,
      tableName,
    } = batchActionEvent;

    // Parse and validate config
    const parsedConfig = ObservationAddToDatasetConfigSchema.parse(config);

    // Get observation stream — use events table when tableName indicates it
    const streamParams = {
      projectId,
      cutoffCreatedAt: new Date(cutoffCreatedAt),
      filter: convertDatesInFiltersFromStrings(query.filter ?? []),
      searchQuery: query.searchQuery ?? undefined,
      searchType: query.searchType ?? ["id" as const],
    };
    const dbReadStream =
      tableName === BatchTableNames.Events
        ? await getEventsStreamForDataset(streamParams)
        : await getObservationStream(streamParams);

    // Collect all observations
    const observations: Array<{
      id: string;
      traceId: string;
      input: unknown;
      output: unknown;
      metadata: unknown;
    }> = [];

    for await (const record of dbReadStream) {
      if (record?.id) {
        observations.push({
          id: record.id,
          traceId: record.traceId,
          input: record.input,
          output: record.output,
          metadata: record.metadata,
        });
      }
    }

    // Process observations and add to dataset
    await processAddObservationsToDataset({
      projectId,
      batchActionId: batchActionId as string,
      config: parsedConfig,
      observations,
    });
  } else if (actionId === "observation-run-batched-evaluation") {
    const { projectId, query, cutoffCreatedAt, evaluatorIds, batchActionId } =
      batchActionEvent;

    if (!batchActionId) {
      throw new Error(
        "batchActionId is required for observation-run-batched-evaluation action",
      );
    }

    const selectedEvaluatorIds = Array.from(new Set(evaluatorIds));

    let evaluators;
    try {
      const rawEvaluators = await prisma.jobConfiguration.findMany({
        where: {
          id: { in: selectedEvaluatorIds },
          projectId,
          targetObject: EvalTargetObject.EVENT,
          // Preserve the selected evaluators as-is. Executability is checked
          // later when each scheduling attempt runs.
        },
        select: {
          id: true,
          projectId: true,
          evalTemplateId: true,
          scoreName: true,
          targetObject: true,
          variableMapping: true,
          status: true,
          blockedAt: true,
        },
      });

      // For batch evaluation the user's table-level selection determines which
      // observations to evaluate, so we intentionally set filter=[] and
      // sampling=1 to ensure every streamed observation is evaluated.
      evaluators = rawEvaluators.map((e) => ({
        ...e,
        filter: [] as [],
        sampling: new Decimal(1),
      }));
    } catch (error) {
      await prisma.batchAction.update({
        where: { id: batchActionId },
        data: {
          status: BatchActionStatus.Failed,
          finishedAt: new Date(),
          totalCount: 0,
          processedCount: 0,
          failedCount: 0,
          log:
            error instanceof Error
              ? error.message
              : "Selected evaluators are missing or not observation-scoped for historical event evaluation.",
        },
      });

      return;
    }

    const dbReadStream = await getEventsStreamForEval({
      projectId,
      cutoffCreatedAt: new Date(cutoffCreatedAt),
      filter: convertDatesInFiltersFromStrings(query.filter ?? []),
      searchQuery: query.searchQuery ?? undefined,
      searchType: query.searchType ?? ["id", "content"],
      rowLimit: env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT,
    });

    await processBatchedObservationEval({
      projectId,
      batchActionId,
      evaluators,
      observationStream: dbReadStream,
    });
  } else if (actionId === ActionId.TraceBatchEvaluation) {
    const { projectId, query, cutoffCreatedAt, evaluatorIds, batchActionId } =
      batchActionEvent;

    if (!batchActionId) {
      throw new Error(
        "batchActionId is required for trace-run-batched-evaluation action",
      );
    }

    const selectedEvaluatorIds = Array.from(new Set(evaluatorIds));

    await prisma.batchAction.update({
      where: { id: batchActionId, projectId },
      data: {
        status: BatchActionStatus.Processing,
        totalCount: 0,
        processedCount: 0,
        failedCount: 0,
        log: null,
      },
    });

    let rawEvaluators;
    try {
      rawEvaluators = await prisma.jobConfiguration.findMany({
        where: {
          id: { in: selectedEvaluatorIds },
          projectId,
          targetObject: EvalTargetObject.TRACE,
        },
        select: {
          id: true,
          projectId: true,
          evalTemplateId: true,
          scoreName: true,
          targetObject: true,
          variableMapping: true,
          status: true,
          blockedAt: true,
          delay: true,
        },
      });
    } catch (error) {
      await prisma.batchAction.update({
        where: { id: batchActionId },
        data: {
          status: BatchActionStatus.Failed,
          finishedAt: new Date(),
          totalCount: 0,
          processedCount: 0,
          failedCount: 0,
          log:
            error instanceof Error
              ? error.message
              : "Selected evaluators are missing or not trace-scoped for historical trace evaluation.",
        },
      });

      return;
    }

    const evaluatorsById = new Map(rawEvaluators.map((e) => [e.id, e]));
    const missingEvaluatorIds = selectedEvaluatorIds.filter(
      (id) => !evaluatorsById.has(id),
    );

    if (missingEvaluatorIds.length > 0) {
      await prisma.batchAction.update({
        where: { id: batchActionId },
        data: {
          status: BatchActionStatus.Failed,
          finishedAt: new Date(),
          totalCount: 0,
          processedCount: 0,
          failedCount: 0,
          log: `Evaluators [${missingEvaluatorIds.join(", ")}] are missing or not trace-scoped.`,
        },
      });

      return;
    }

    const dbReadStream = await getTraceIdentifierStream({
      projectId,
      cutoffCreatedAt: new Date(cutoffCreatedAt),
      filter: convertDatesInFiltersFromStrings(query.filter ?? []),
      orderBy: query.orderBy,
      searchQuery: query.searchQuery ?? undefined,
      searchType: query.searchType ?? ["id"],
      rowLimit: env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT,
    });

    const evalQueue = EvalExecutionQueue.getInstance();
    if (!evalQueue) {
      throw new Error("EvalExecutionQueue is not initialized");
    }

    let totalCount = 0;
    let processedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    for await (const record of dbReadStream) {
      totalCount++;

      if (!assertIsTracesTableRecord(record)) {
        failedCount++;
        if (errors.length < MAX_BATCH_ACTION_LOG_LINES) {
          errors.push(`Row ${totalCount}: Invalid trace record.`);
        }
        continue;
      }

      for (const evaluatorId of selectedEvaluatorIds) {
        const evaluator = evaluatorsById.get(evaluatorId);
        if (!evaluator) continue;

        try {
          const jobExecutionId = `${evaluator.id}:${record.id}`;
          const jobExecution = await prisma.jobExecution.upsert({
            where: {
              id: jobExecutionId,
              projectId,
            },
            create: {
              id: jobExecutionId,
              projectId,
              jobConfigurationId: evaluator.id,
              jobInputTraceId: record.id,
              jobInputTraceTimestamp: new Date(record.timestamp),
              jobTemplateId: evaluator.evalTemplateId,
              status: "PENDING",
              startTime: new Date(),
            },
            update: {
              status: "PENDING",
              jobInputTraceTimestamp: new Date(record.timestamp),
            },
          });

          await evalQueue.add(
            QueueName.EvaluationExecution,
            {
              name: QueueJobs.EvaluationExecution,
              id: randomUUID(),
              timestamp: new Date(),
              payload: {
                projectId,
                jobExecutionId: jobExecution.id,
                delay: evaluator.delay,
              },
              retryBaggage: {
                originalJobTimestamp: new Date(),
                attempt: 0,
              },
            },
            {
              delay: evaluator.delay ?? undefined,
            },
          );
          processedCount++;
        } catch (error) {
          failedCount++;
          if (errors.length < MAX_BATCH_ACTION_LOG_LINES) {
            errors.push(
              `Trace ${record.id}, evaluator ${evaluator.scoreName}: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
          }
        }
      }

      await prisma.batchAction.update({
        where: { id: batchActionId, projectId },
        data: {
          totalCount,
          processedCount,
          failedCount,
        },
      });
    }

    const finalStatus =
      failedCount === 0
        ? BatchActionStatus.Completed
        : processedCount === 0
          ? BatchActionStatus.Failed
          : BatchActionStatus.Partial;

    await prisma.batchAction.update({
      where: { id: batchActionId, projectId },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
        totalCount,
        processedCount,
        failedCount,
        log: errors.length > 0 ? errors.join("\n") : null,
      },
    });
  }

  logger.info(
    `Batch action job completed, projectId: ${batchActionJob.payload.projectId}, actionId: ${actionId}`,
  );
};
