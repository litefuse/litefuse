import type { WorkHandler } from "pg-boss";
import {
  logger,
  type QueueName,
  ensurePgBossEventQueue,
  getPgBoss,
  getPgBossQueueConfig,
  registerPgBossWorker,
  type PgBossScheduleDefinition,
  type PgBossJobEnvelope,
} from "@langfuse/shared/src/server";

type EventJobData = PgBossJobEnvelope<Record<string, unknown>>;

export type PgBossWorkerOptions = {
  localConcurrency?: number;
  pollingIntervalSeconds?: number;
  batchSize?: number;
  consumeMode?: "polling" | "drain";
  queueOptions?: PgBossScheduleDefinition["queueOptions"];
  concurrency?: number;
  limiter?: any;
  lockDuration?: any;
  stalledInterval?: any;
  maxStalledCount?: any;
  rateLimit?: { max: number; duration: number };
};

const rateLimiterBuckets = new Map<
  QueueName,
  { tokens: number; lastRefill: number }
>();
const drainLoops = new Map<QueueName, { stopped: boolean }>();

function acquireRateLimitSlot(
  queueName: QueueName,
  opts: PgBossWorkerOptions,
): boolean {
  const limit = opts.rateLimit;
  if (!limit) return true;

  const now = Date.now();
  let bucket = rateLimiterBuckets.get(queueName);
  if (!bucket) {
    bucket = { tokens: limit.max, lastRefill: now };
    rateLimiterBuckets.set(queueName, bucket);
  }

  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor((elapsed / limit.duration) * limit.max);
  if (refill > 0) {
    bucket.tokens = Math.min(limit.max, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }
  return false;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const serializeErrorData = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
};

const stopDrainLoops = (): void => {
  for (const loop of drainLoops.values()) {
    loop.stopped = true;
  }
  drainLoops.clear();
};

export class WorkerManager {
  private static registered: Set<QueueName> = new Set();

  static wrapProcessor(
    processor: (job: any) => Promise<any>,
  ): WorkHandler<EventJobData> {
    return async (jobs) => {
      for (const j of jobs) {
        const jobData = j.data as Record<string, unknown>;
        const jobName = (jobData.name as string | undefined) ?? j.name;
        const jobId = (jobData.id as string | undefined) ?? j.id;
        await processor({
          id: j.id,
          name: jobName,
          data: {
            ...jobData,
            id: jobId,
            timestamp: new Date(String(jobData.timestamp)),
          },
          opts: { repeat: undefined, jobId },
          updateProgress: async () => {},
        } as any);
      }
    };
  }

  static register(
    queueName: QueueName,
    handler: WorkHandler<EventJobData> | ((job: any) => Promise<any>),
    options: PgBossWorkerOptions = {},
  ): void {
    if (options.consumeMode === "drain" && options.rateLimit) {
      throw new Error(
        `Drain consume mode does not support rate limiting for queue ${queueName}`,
      );
    }

    if (WorkerManager.registered.has(queueName)) {
      logger.debug(`pg-boss worker ${queueName} already registered, skipping`);
      return;
    }
    WorkerManager.registered.add(queueName);

    const pgHandler = WorkerManager.wrapProcessor(
      handler as (job: any) => Promise<any>,
    );

    const rateLimit = options.rateLimit;

    void (async () => {
      try {
        const queueConfig = getPgBossQueueConfig(queueName);
        await ensurePgBossEventQueue(
          queueName,
          options.queueOptions ??
            ({} as PgBossScheduleDefinition["queueOptions"]),
        );

        const wrapped: WorkHandler<EventJobData> = async (jobs) => {
          if (rateLimit && !acquireRateLimitSlot(queueName, options)) {
            throw new RateLimitError(queueName);
          }
          await pgHandler(jobs);
        };

        const workerOpts = {
          localConcurrency:
            options.concurrency ?? options.localConcurrency ?? 1,
          pollingIntervalSeconds:
            options.pollingIntervalSeconds ??
            queueConfig.defaultWorkOptions?.pollingIntervalSeconds ??
            1,
          batchSize:
            options.batchSize ?? queueConfig.defaultWorkOptions?.batchSize,
        };
        if (rateLimit) {
          workerOpts.batchSize = 1;
        }

        if (options.consumeMode === "drain") {
          WorkerManager.startDrainWorkers(queueName, workerOpts, wrapped);
        } else {
          await registerPgBossWorker<EventJobData>(
            queueName,
            workerOpts,
            wrapped,
          );
        }

        logger.info("pg-boss worker registered", {
          queueName,
          ...options,
        });
      } catch (err) {
        logger.error(`Failed to register pg-boss worker for ${queueName}`, err);
      }
    })();
  }

  static isRegistered(queueName: QueueName): boolean {
    return WorkerManager.registered.has(queueName);
  }

  static __testReset(): void {
    stopDrainLoops();
    WorkerManager.registered.clear();
    rateLimiterBuckets.clear();
  }

  static close(): void {
    stopDrainLoops();
    WorkerManager.registered.clear();
    rateLimiterBuckets.clear();
  }

  private static startDrainWorkers(
    queueName: QueueName,
    workerOpts: {
      localConcurrency: number;
      pollingIntervalSeconds: number;
      batchSize?: number;
    },
    handler: WorkHandler<EventJobData>,
  ): void {
    const loopState = { stopped: false };
    drainLoops.set(queueName, loopState);

    for (let i = 0; i < workerOpts.localConcurrency; i++) {
      void WorkerManager.runDrainLoop(
        queueName,
        workerOpts,
        handler,
        loopState,
      );
    }
  }

  private static async runDrainLoop(
    queueName: QueueName,
    workerOpts: {
      localConcurrency: number;
      pollingIntervalSeconds: number;
      batchSize?: number;
    },
    handler: WorkHandler<EventJobData>,
    loopState: { stopped: boolean },
  ): Promise<void> {
    const boss = await getPgBoss();
    const pollingDelayMs = Math.max(
      workerOpts.pollingIntervalSeconds * 1000,
      100,
    );

    while (!loopState.stopped) {
      try {
        const jobs =
          (await boss.fetch<EventJobData>(queueName, {
            batchSize: workerOpts.batchSize,
          })) ?? [];

        if (jobs.length === 0) {
          await sleep(pollingDelayMs);
          continue;
        }

        try {
          // Drain mode processes one fetched batch without polling delay between
          // fetches, so settle each job separately to avoid re-running already
          // completed work when one job in the batch fails.
          const jobResults = await Promise.allSettled(
            jobs.map(async (job) => handler([job])),
          );

          const completedJobIds: string[] = [];
          const failedJobs: Array<{ id: string; error: unknown }> = [];

          jobResults.forEach((result, index) => {
            if (result.status === "fulfilled") {
              completedJobIds.push(jobs[index].id);
            } else {
              failedJobs.push({ id: jobs[index].id, error: result.reason });
            }
          });

          if (completedJobIds.length > 0) {
            await boss.complete(queueName, completedJobIds);
          }

          await Promise.all(
            failedJobs.map((failedJob) =>
              boss.fail(
                queueName,
                [failedJob.id],
                serializeErrorData(failedJob.error),
              ),
            ),
          );
        } catch (error) {
          logger.error(
            `pg-boss drain worker batch failed for ${queueName}`,
            error,
          );
          await Promise.all(
            jobs.map((job) =>
              boss.fail(queueName, [job.id], serializeErrorData(error)),
            ),
          );
        }
      } catch (error) {
        logger.error(
          `pg-boss drain worker loop failed for ${queueName}`,
          error,
        );
        await sleep(pollingDelayMs);
      }
    }
  }
}

class RateLimitError extends Error {
  constructor(queueName: QueueName) {
    super(`Rate limit exceeded for queue ${queueName}`);
    this.name = "RateLimitError";
  }
}
