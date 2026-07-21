import { Queue } from "bullmq";
import { env } from "../../env";
import { logger } from "../logger";
import { QueueJobs, QueueName } from "../queues";
import {
  createNewRedisInstance,
  getQueuePrefix,
  redisQueueRetryOptions,
} from "./redis";

export class CloudFreeTierUsageThresholdQueue {
  private static instance: Queue | null = null;

  public static getInstance(): Queue | null {
    if (!env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION) return null;
    if (CloudFreeTierUsageThresholdQueue.instance) {
      return CloudFreeTierUsageThresholdQueue.instance;
    }

    const connection = createNewRedisInstance({
      enableOfflineQueue: false,
      ...redisQueueRetryOptions,
    });
    CloudFreeTierUsageThresholdQueue.instance = connection
      ? new Queue(QueueName.CloudFreeTierUsageThresholdQueue, {
          connection,
          prefix: getQueuePrefix(QueueName.CloudFreeTierUsageThresholdQueue),
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: 100,
            attempts: 5,
            backoff: { type: "exponential", delay: 5000 },
          },
        })
      : null;

    CloudFreeTierUsageThresholdQueue.instance?.on("error", (error) => {
      logger.error("CloudFreeTierUsageThresholdQueue error", error);
    });
    void CloudFreeTierUsageThresholdQueue.instance?.add(
      QueueJobs.CloudFreeTierUsageThresholdJob,
      {},
      { repeat: { pattern: "35 * * * *" } },
    );
    return CloudFreeTierUsageThresholdQueue.instance;
  }
}
