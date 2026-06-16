import { traceException, logger } from "@langfuse/shared/src/server";
import { type QueueName } from "@langfuse/shared/src/server";
import { handleBatchActionJob } from "../features/batchAction/handleBatchActionJob";
import type { QueueJobLike } from "./types";

export const batchActionQueueProcessor = async (
  job: QueueJobLike<QueueName.BatchActionQueue>,
) => {
  try {
    logger.info(
      `Executing Batch Action job ${JSON.stringify(job.data.payload.actionId)}`,
    );
    await handleBatchActionJob(job.data);
    logger.info(
      `Finished Batch Action Job ${JSON.stringify(job.data.payload.actionId)}`,
    );

    return true;
  } catch (e) {
    logger.error(`Failed Batch Action job for id ${job.id}`, e);
    traceException(e);
    throw e;
  }
};
