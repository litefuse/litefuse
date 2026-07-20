import { Queue } from "bullmq";
import { env } from "../../env";
import { logger } from "../logger";
import { QueueJobs, QueueName } from "../queues";
import {
  createNewRedisInstance,
  getQueuePrefix,
  redisQueueRetryOptions,
} from "./redis";

export class CloudUsageMeteringQueue {
  private static instance: Queue | null = null;

  public static getInstance(): Queue | null {
    if (!env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION || !env.STRIPE_SECRET_KEY) {
      return null;
    }
    if (CloudUsageMeteringQueue.instance)
      return CloudUsageMeteringQueue.instance;

    const connection = createNewRedisInstance({
      enableOfflineQueue: false,
      ...redisQueueRetryOptions,
    });
    CloudUsageMeteringQueue.instance = connection
      ? new Queue(QueueName.CloudUsageMeteringQueue, {
          connection,
          prefix: getQueuePrefix(QueueName.CloudUsageMeteringQueue),
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: 100,
            attempts: 5,
            backoff: { type: "exponential", delay: 5000 },
          },
        })
      : null;

    CloudUsageMeteringQueue.instance?.on("error", (error) => {
      logger.error("CloudUsageMeteringQueue error", error);
    });
    void CloudUsageMeteringQueue.instance?.add(
      QueueJobs.CloudUsageMeteringJob,
      {},
      { repeat: { pattern: "5 * * * *" } },
    );
    void CloudUsageMeteringQueue.instance?.add(
      QueueJobs.CloudUsageMeteringJob,
      {},
      { jobId: "cloud-usage-metering-bootstrap" },
    );
    return CloudUsageMeteringQueue.instance;
  }
}
