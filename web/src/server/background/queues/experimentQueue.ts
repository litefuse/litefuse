import {
  QueueJobs,
  QueueName,
  type TQueueJobTypes,
  isLLMCompletionError,
  logger,
  traceException,
  getPgBossQueue,
  type PgBossJobEnvelope,
} from "@langfuse/shared/src/server";
import { retryLLMRateLimitError } from "../features/utils";
import { delayInMs } from "./utils/delays";
import { createExperimentJobDoris } from "../features/experiments/experimentServiceDoris";
import { isUnrecoverableError } from "../errors/UnrecoverableError";

type ExperimentCreatePayload =
  TQueueJobTypes[QueueName.ExperimentCreate]["payload"];

export const experimentCreateQueueProcessor = async (job: {
  data: PgBossJobEnvelope<ExperimentCreatePayload>;
}) => {
  try {
    await createExperimentJobDoris({ event: job.data.payload });
    return true;
  } catch (e) {
    if (isLLMCompletionError(e) && e.isRetryable) {
      await retryLLMRateLimitError(
        {
          data: {
            payload: job.data.payload,
            timestamp: new Date(job.data.timestamp),
          },
        },
        {
          table: "dataset_runs",
          idField: "runId",
          enqueue: async (payload, delayMs) => {
            const q = getPgBossQueue(QueueName.ExperimentCreate);
            await q.sendDelayed(
              QueueJobs.ExperimentCreateJob,
              {
                projectId: (payload as any).projectId,
                datasetId: (payload as any).datasetId,
                runId: (payload as any).runId,
                description: (payload as any).description,
              },
              delayMs / 1000,
            );
          },
          queueName: QueueName.ExperimentCreate,
          delayFn: delayInMs,
        },
      );
      return;
    }
    if (isLLMCompletionError(e) || isUnrecoverableError(e)) return;
    logger.error(
      `Failed to process experiment create job for project: ${job.data.payload.projectId}`,
      e,
    );
    traceException(e);
    throw e;
  }
};
