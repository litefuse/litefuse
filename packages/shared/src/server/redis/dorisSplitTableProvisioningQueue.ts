import { QueueName, QueueJobs, TQueueJobTypes } from "../queues";
import { Queue } from "bullmq";
import {
  createNewRedisInstance,
  redisQueueRetryOptions,
  getQueuePrefix,
} from "./redis";
import { logger } from "../logger";

/**
 * Per-project Doris split-table provisioning queue (Stage 1.2b). One job per
 * project creates its spans_<pid> / traces_scalar_<pid> tables + MV
 * (idempotent). jobId = projectId gives per-project SERIALISATION + de-dup:
 * BullMQ will not run two jobs with the same id concurrently, and a duplicate
 * enqueue while one is waiting/active is dropped. Removed on completion, so a
 * later re-provision (retention change, re-create) enqueues cleanly.
 */
export class DorisSplitTableProvisioningQueue {
  private static instance: Queue<
    TQueueJobTypes[QueueName.DorisSplitTableProvisioningQueue]
  > | null = null;

  public static getInstance(): Queue<
    TQueueJobTypes[QueueName.DorisSplitTableProvisioningQueue]
  > | null {
    if (DorisSplitTableProvisioningQueue.instance)
      return DorisSplitTableProvisioningQueue.instance;

    const newRedis = createNewRedisInstance({
      enableOfflineQueue: false,
      ...redisQueueRetryOptions,
    });

    DorisSplitTableProvisioningQueue.instance = newRedis
      ? new Queue<TQueueJobTypes[QueueName.DorisSplitTableProvisioningQueue]>(
          QueueName.DorisSplitTableProvisioningQueue,
          {
            connection: newRedis,
            prefix: getQueuePrefix(QueueName.DorisSplitTableProvisioningQueue),
            defaultJobOptions: {
              removeOnComplete: true,
              removeOnFail: 10_000,
              // Provisioning (CREATE TABLE + async MV build) can transiently
              // fail on a busy/booting Doris — retry generously with backoff.
              attempts: 20,
              backoff: { type: "exponential", delay: 10_000 },
            },
          },
        )
      : null;

    DorisSplitTableProvisioningQueue.instance?.on("error", (err) => {
      logger.error("DorisSplitTableProvisioningQueue error", err);
    });

    return DorisSplitTableProvisioningQueue.instance;
  }
}

/**
 * Enqueue provisioning for a project (idempotent — jobId = projectId). Call
 * when a project is designated to split (control-table write / creation hook).
 */
export const enqueueDorisSplitTableProvisioning = async (
  projectId: string,
): Promise<void> => {
  const queue = DorisSplitTableProvisioningQueue.getInstance();
  if (!queue) {
    logger.error(
      `[table-split] provisioning queue unavailable; cannot provision ${projectId}`,
    );
    return;
  }
  await queue.add(
    QueueJobs.DorisSplitTableProvisioningJob,
    {
      timestamp: new Date(),
      id: projectId,
      payload: { projectId },
      name: QueueJobs.DorisSplitTableProvisioningJob,
    },
    { jobId: projectId },
  );
};
