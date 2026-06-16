import pLimit from "p-limit";
import { prisma } from "@langfuse/shared/src/db";
import { BatchActionStatus, observationForEvalSchema } from "@langfuse/shared";
import { logger, traceException } from "@langfuse/shared/src/server";
import {
  createObservationEvalSchedulerDeps,
  scheduleObservationEvals,
  type ObservationEvalConfig,
} from "../evaluation/observationEval";

const BATCH_SIZE = 500;
const CONCURRENCY_LIMIT = 50;
const MAX_ERROR_LOG_LINES = 20;

// Extract the YYYY-MM-DD partition key from a streamed `start_time`.
// Doris returns DATETIME as a `Date` (via the JS driver) or as a
// `YYYY-MM-DD HH:mm:ss` / ISO string. Throws on missing — start_time
// is part of events_full's primary key, so every streamed row has it,
// and falling back to "today" would hit every partition.
const toStartTimeDate = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString().split("T")[0];
  if (typeof value === "string" && value.length >= 10) {
    return value.slice(0, 10);
  }
  throw new Error(
    `Cannot derive start_time_date: streamed record has no usable start_time (got ${typeof value})`,
  );
};

export async function processBatchedObservationEval(params: {
  projectId: string;
  batchActionId: string;
  evaluators: ObservationEvalConfig[];
  observationStream: AsyncIterable<Record<string, unknown>>;
}): Promise<void> {
  const { projectId, batchActionId, evaluators, observationStream } = params;
  const limit = pLimit(CONCURRENCY_LIMIT);
  const schedulerDeps = createObservationEvalSchedulerDeps();

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

  let totalCount = 0;
  let processedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  let buffer: Record<string, unknown>[] = [];

  const processBatch = async (batch: Record<string, unknown>[]) => {
    const results = await Promise.allSettled(
      batch.map((record) =>
        limit(async () => {
          const observation = observationForEvalSchema.parse(record);
          // events_full is range-partitioned on start_time_date; the
          // eval processor needs it to prune partitions when re-reading
          // the row. Derive from start_time on the streamed record.
          const startTimeDate = toStartTimeDate(record.start_time);
          await scheduleObservationEvals({
            observation,
            startTimeDate,
            configs: evaluators,
            schedulerDeps,
          });
        }),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];

      if (result.status === "fulfilled") {
        processedCount++;
      } else {
        failedCount++;
        traceException(result.reason);

        if (errors.length < MAX_ERROR_LOG_LINES) {
          const errorMessage =
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error";
          errors.push(
            `Row ${totalCount - batch.length + i + 1}: ${errorMessage}`,
          );
        }
      }
    }

    await prisma.batchAction.update({
      where: { id: batchActionId, projectId },
      data: { totalCount, processedCount, failedCount },
    });
  };

  for await (const record of observationStream) {
    buffer.push(record);
    totalCount++;

    if (buffer.length >= BATCH_SIZE) {
      await processBatch(buffer);
      buffer = [];
    }
  }

  // Process remaining records
  if (buffer.length > 0) {
    await processBatch(buffer);
  }

  const finalStatus =
    failedCount === 0
      ? BatchActionStatus.Completed
      : processedCount === 0
        ? BatchActionStatus.Failed
        : BatchActionStatus.Partial;

  const errorSummary =
    errors.length > 0
      ? `${failedCount} observations failed while scheduling ${evaluators.length} evaluator(s): ${evaluators.map((evaluator) => evaluator.scoreName).join(", ")}.\n${errors.join("\n")}`
      : null;

  await prisma.batchAction.update({
    where: { id: batchActionId, projectId },
    data: {
      status: finalStatus,
      finishedAt: new Date(),
      totalCount,
      processedCount,
      failedCount,
      log: errorSummary,
    },
  });

  logger.info(
    `Completed observation-run-batched-evaluation action ${batchActionId}`,
    {
      totalCount,
      processedCount,
      failedCount,
      finalStatus,
    },
  );
}
