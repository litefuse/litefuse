import { logger, type QueueName } from "@langfuse/shared/src/server";
import { entityChangeWorker } from "../features/entityChange/entityChangeWorker";
import type { QueueJobLike } from "./types";

export const entityChangeQueueProcessor = async (
  job: QueueJobLike<QueueName.EntityChangeQueue>,
) => {
  if (logger.isLevelEnabled("debug")) {
    logger.debug(
      `Processing entity change event for entity ${job.data.payload.entityType}, event: ${JSON.stringify(
        job.data,
        null,
        2,
      )}`,
    );
  }
  return await entityChangeWorker(job.data.payload);
};
