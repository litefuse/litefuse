import { Queue } from "bullmq";
import { QueueName, TQueueJobTypes } from "../queues";
import {
  createNewRedisInstance,
  redisQueueRetryOptions,
  getQueuePrefix,
} from "./redis";
import { logger } from "../logger";
import { getShardIndex } from "./sharding";
import { env } from "../../env";
import { randomUUID } from "crypto";

export class OtelIngestionQueue {
  private static instances: Map<
    number,
    Queue<TQueueJobTypes[QueueName.OtelIngestionQueue]> | null
  > = new Map();

  public static getShardNames() {
    return Array.from(
      { length: env.LITEFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT },
      (_, i) => `${QueueName.OtelIngestionQueue}${i > 0 ? `-${i}` : ""}`,
    );
  }

  static getShardIndexFromShardName(
    shardName: string | undefined,
  ): number | null {
    if (!shardName) return null;

    // Extract shard index from shard name
    const shardIndex =
      shardName === QueueName.OtelIngestionQueue
        ? 0
        : parseInt(
            shardName.replace(`${QueueName.OtelIngestionQueue}-`, ""),
            10,
          );

    if (isNaN(shardIndex)) return null;
    return shardIndex;
  }

  /**
   * Get the otel ingestion queue instance for the given shard name. If not provided, uses a random shard.
   * @param shardName - Name of the shard. Should be `otel-ingestion-queue-${shardIndex}` or plainly `otel-ingestion-queue` for the first shard.
   */
  public static getInstance({
    shardName,
  }: {
    shardName?: string;
  }): Queue<TQueueJobTypes[QueueName.OtelIngestionQueue]> | null {
    const shardIndex =
      OtelIngestionQueue.getShardIndexFromShardName(shardName) ??
      (env.REDIS_CLUSTER_ENABLED === "true"
        ? getShardIndex(
            randomUUID(),
            env.LITEFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT,
          )
        : 0);

    // Check if we already have an instance for this shard
    if (OtelIngestionQueue.instances.has(shardIndex)) {
      return OtelIngestionQueue.instances.get(shardIndex) || null;
    }

    const newRedis = createNewRedisInstance({
      enableOfflineQueue: false,
      ...redisQueueRetryOptions,
    });

    const name = `${QueueName.OtelIngestionQueue}${shardIndex > 0 ? `-${shardIndex}` : ""}`;
    const queueInstance = newRedis
      ? new Queue<TQueueJobTypes[QueueName.OtelIngestionQueue]>(name, {
          connection: newRedis,
          prefix: getQueuePrefix(name),
          defaultJobOptions: {
            removeOnComplete: true,
            // TIME-based retention (seconds), not count-based: with a count
            // cap a long Doris outage silently evicts the OLDEST failed jobs
            // once the cap fills (~33min at 50 files/s) — the job pointer
            // (the only automatic recovery handle) evaporates. 7 days gives
            // the DLQ redrive + age guard + reconciliation chain room to act.
            // Must stay > the failed-age alert threshold + ops SLA.
            removeOnFail: { age: 7 * 24 * 3600 },
            attempts: 6,
            backoff: {
              type: "exponential",
              delay: 5000,
            },
          },
        })
      : null;

    queueInstance?.on("error", (err) => {
      logger.error(`OtelIngestionQueue shard ${shardIndex} error`, err);
    });

    OtelIngestionQueue.instances.set(shardIndex, queueInstance);

    return queueInstance;
  }
}
