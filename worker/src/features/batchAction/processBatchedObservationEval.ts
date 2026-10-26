import pLimit from "p-limit";
import { prisma } from "@langfuse/shared/src/db";
import { BatchActionStatus, observationForEvalSchema } from "@langfuse/shared";
import { logger, traceException } from "@langfuse/shared/src/server";
import {
  createObservationEvalSchedulerDeps,
  scheduleObservationEvals,
  type ObservationEvalRule,
} from "../evaluation/observationEval";

const BATCH_SIZE = 500;
const CONCURRENCY_LIMIT = 50;
const MAX_ERROR_LOG_LINES = 20;

export async function processBatchedObservationEval(params: {
  projectId: string;
  batchActionId: string;
  /** Legacy job configurations or evaluator v2 rules (see the batch handler). */
  evaluators: ObservationEvalRule[];
  /** Display names for the run log; v2 entries carry no `scoreName`. */
  evaluatorLabels?: string[];
  observationStream: AsyncIterable<Record<string, unknown>>;
}): Promise<void> {
  const {
    projectId,
    batchActionId,
    evaluators,
    evaluatorLabels,
    observationStream,
  } = params;
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
          // Derived (no storage counterpart): upstream's numeric `toolCalls`
          // filter is the tool-call count, and `tool_call_names` is
          // authoritative for count and order. The batch stream carries the
          // arrays, not a count, so the projection derives it here — same
          // derivation as the live OTel path and the v2 test-run path.
          const toolCallNames = Array.isArray(record.tool_call_names)
            ? record.tool_call_names
            : [];
          const observation = observationForEvalSchema.parse({
            ...record,
            tool_call_count: toolCallNames.length,
          });
          await scheduleObservationEvals({
            observation,
            configs: evaluators,
            schedulerDeps,
            // A manual run is authorized by the user's own selection: the
            // executor must not cancel it because the rule was deactivated after
            // the batch was queued.
            executionMode: "MANUAL",
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

  // LITEFUSE NOTE: a v2 rule entry carries no `scoreName` (the executor resolves
  // the evaluator at pickup), so the caller passes display labels. Legacy entries
  // still have `scoreName`, which is used as the fallback.
  const evaluatorNames =
    evaluatorLabels ??
    evaluators.map((evaluator) =>
      "scoreName" in evaluator ? evaluator.scoreName : evaluator.id,
    );

  const errorSummary =
    errors.length > 0
      ? `${failedCount} observations failed while scheduling ${evaluators.length} evaluator(s): ${evaluatorNames.join(", ")}.\n${errors.join("\n")}`
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
