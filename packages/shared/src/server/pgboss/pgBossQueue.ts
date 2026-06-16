import type {
  FindJobsOptions,
  Job,
  JobWithMetadata,
  QueuePolicy,
  ScheduleOptions,
  SendOptions,
  WorkHandler,
  WorkOptions,
} from "pg-boss";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import { QueueJobs, QueueName } from "../queues";
import { derivePgBossJobId } from "./pgBossJobId";
import { startPgBoss } from "./pgBoss";

type QueueSendOptions = SendOptions & {
  retryBaggage?: { originalJobTimestamp: Date; attempt: number };
};

const resolveDuplicateJobId = async (
  boss: Awaited<ReturnType<typeof startPgBoss>>,
  queueName: QueueName,
  options: { id?: string; singletonKey?: string },
): Promise<string | null> => {
  if (options.id) {
    const existing = await boss.getJobById(queueName, options.id);
    if (existing) return existing.id;
  }

  if (options.singletonKey) {
    const existing = await boss.findJobs(queueName, {
      key: options.singletonKey,
    });
    if (existing[0]) return existing[0].id;
  }

  return null;
};

// ── Types ──────────────────────────────────────────────────────────

/** Standard job envelope for pg-boss (mirrors BullMQ structure) */
export type PgBossJobEnvelope<TPayload> = {
  id?: string;
  name: QueueJobs;
  timestamp: string;
  payload: TPayload;
  retryBaggage?: {
    originalJobTimestamp: Date;
    attempt: number;
  };
};

/** Configuration for a single pg-boss queue */
export type PgBossQueueConfig = {
  queueName: QueueName;
  /** Default queue options (retry, expiration, etc.) */
  queueOptions: {
    policy?: QueuePolicy;
    retryLimit: number;
    retryDelay: number;
    retryBackoff: boolean;
    deleteAfterSeconds?: number;
    expireInSeconds?: number;
    retentionSeconds?: number;
  };
  /** Default send options for jobs */
  defaultSendOptions?: SendOptions;
  /** Default work options for workers */
  defaultWorkOptions?: WorkOptions;
};

// ── PgBossQueue — generic typed queue manager ──────────────────────

export class PgBossQueue<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly config: PgBossQueueConfig;
  private workersRegistered = 0;

  constructor(config: PgBossQueueConfig) {
    this.config = config;
  }

  get queueName(): QueueName {
    return this.config.queueName;
  }

  // ── Enqueue ──────────────────────────────────────────────────────

  /**
   * Send a single job to the queue.
   * Mirrors: queue.add(name, data, opts)
   * Throws on failure (BullMQ-compatible semantics).
   */
  async send(
    jobName: QueueJobs,
    payload: TPayload,
    options?: QueueSendOptions,
  ): Promise<string> {
    const boss = await startPgBoss();
    // ensureQueue is always called via boss.createQueue (idempotent)
    await boss.createQueue(this.config.queueName, this.config.queueOptions);

    const { retryBaggage, ...sendOptions } = options ?? {};
    const explicitId = sendOptions.id;
    const jobId = derivePgBossJobId(
      this.config.queueName,
      sendOptions,
      randomUUID(),
    );

    const id = await boss.send(
      this.config.queueName,
      {
        id: jobId,
        name: jobName,
        timestamp: new Date().toISOString(),
        payload,
        ...(retryBaggage ? { retryBaggage } : {}),
      } satisfies PgBossJobEnvelope<TPayload>,
      {
        ...this.config.defaultSendOptions,
        ...sendOptions,
        id: jobId,
      },
    );

    if (!id) {
      const duplicateJobId = await resolveDuplicateJobId(
        boss,
        this.config.queueName,
        {
          id: explicitId,
          singletonKey: sendOptions.singletonKey,
        },
      );

      if (duplicateJobId) {
        logger.debug("pg-boss duplicate job suppressed", {
          queueName: this.config.queueName,
          jobName,
          jobId: duplicateJobId,
          singletonKey: sendOptions.singletonKey,
        });
        return duplicateJobId;
      }

      throw new Error(
        `pg-boss send returned null for queue ${this.config.queueName} job ${jobName}`,
      );
    }

    logger.debug("pg-boss job enqueued", {
      queueName: this.config.queueName,
      jobName,
      jobId: id,
    });

    return id;
  }

  /**
   * Send a job with a start-after delay (in seconds).
   * Mirrors: queue.add(name, data, { delay })
   */
  async sendDelayed(
    jobName: QueueJobs,
    payload: TPayload,
    startAfterSeconds: number,
    options?: QueueSendOptions,
  ): Promise<string> {
    return this.send(jobName, payload, {
      ...options,
      startAfter: startAfterSeconds,
    });
  }

  /**
   * Send a singleton job (at most one pending/active instance per key).
   * Mirrors: queue.add(name, data, { jobId }) for dedup
   */
  async sendSingleton(
    jobName: QueueJobs,
    payload: TPayload,
    singletonKey: string,
    options?: QueueSendOptions,
  ): Promise<string> {
    return this.send(jobName, payload, {
      ...options,
      singletonKey,
    });
  }

  /**
   * Insert multiple jobs at once.
   * Mirrors: queue.addBulk(jobs)
   */
  async insertBulk(
    jobs: Array<{
      jobName: QueueJobs;
      payload: TPayload;
      options?: SendOptions;
    }>,
  ): Promise<string[]> {
    const boss = await startPgBoss();
    await boss.createQueue(this.config.queueName, this.config.queueOptions);

    const insertJobs = jobs.map((j) => {
      const jobId = derivePgBossJobId(
        this.config.queueName,
        j.options ?? {},
        randomUUID(),
      );
      return {
        id: jobId,
        data: {
          id: jobId,
          name: j.jobName,
          timestamp: new Date().toISOString(),
          payload: j.payload,
        } satisfies PgBossJobEnvelope<TPayload>,
        ...j.options,
      };
    });

    const ids = await boss.insert(this.config.queueName, insertJobs, {
      ...this.config.defaultSendOptions,
      returnId: true,
    });

    logger.debug("pg-boss bulk insert", {
      queueName: this.config.queueName,
      count: ids?.length ?? 0,
    });

    return ids ?? [];
  }

  // ── Worker (consume) ─────────────────────────────────────────────

  /**
   * Register a worker to process jobs from this queue.
   * Mirrors: WorkerManager.register(queueName, processor, options)
   *
   * Returns a workerId that can be passed to unregisterWorker().
   * Repeated calls register additional workers (pg-boss supports N per process).
   */
  async registerWorker(
    options: WorkOptions,
    handler: WorkHandler<PgBossJobEnvelope<TPayload>>,
  ): Promise<string> {
    const mergedOptions: WorkOptions = {
      ...this.config.defaultWorkOptions,
      ...options,
    };

    const boss = await startPgBoss();
    // Ensure the queue exists before registering a worker against it.
    // pg-boss work() will poll this queue; if the queue was never created,
    // every poll cycle will emit an error.
    await boss.createQueue(this.config.queueName, this.config.queueOptions);
    const workerId = await boss.work<PgBossJobEnvelope<TPayload>>(
      this.config.queueName,
      mergedOptions,
      handler,
    );

    this.workersRegistered++;

    logger.info("pg-boss worker registered", {
      queueName: this.config.queueName,
      workerId,
      totalWorkers: this.workersRegistered,
      options: mergedOptions,
    });

    return workerId;
  }

  /**
   * Unregister a worker by its worker ID (returned from registerWorker).
   */
  async unregisterWorker(workerId: string): Promise<void> {
    try {
      const boss = await startPgBoss();
      await boss.offWork(this.config.queueName, { id: workerId });
      this.workersRegistered = Math.max(0, this.workersRegistered - 1);

      logger.info("pg-boss worker unregistered", {
        queueName: this.config.queueName,
        workerId,
        totalWorkers: this.workersRegistered,
      });
    } catch (error) {
      logger.error("pg-boss unregisterWorker failed", {
        queueName: this.config.queueName,
        workerId,
        error,
      });
      throw error;
    }
  }

  // ── Schedule (cron) ──────────────────────────────────────────────

  /**
   * Register a recurring cron schedule for this queue.
   * Mirrors: queue.add(name, data, { repeat: { pattern: cron } })
   */
  async schedule(
    jobName: QueueJobs,
    cron: string,
    payload: TPayload = {} as TPayload,
    options?: {
      key?: string;
      scheduleOptions?: Omit<ScheduleOptions, "key" | "tz">;
      sendOptions?: SendOptions;
    },
  ): Promise<void> {
    const boss = await startPgBoss();
    await boss.createQueue(this.config.queueName, this.config.queueOptions);

    const key = options?.key ?? `${this.config.queueName}-recurring`;

    await boss.schedule(
      this.config.queueName,
      cron,
      {
        name: jobName,
        timestamp: new Date().toISOString(),
        payload,
      } satisfies PgBossJobEnvelope<TPayload>,
      {
        key,
        ...options?.scheduleOptions,
        ...options?.sendOptions,
      },
    );

    logger.info("pg-boss schedule registered", {
      queueName: this.config.queueName,
      jobName,
      cron,
      key,
    });
  }

  /**
   * Cancel a scheduled recurring job.
   */
  async unschedule(key: string): Promise<void> {
    const boss = await startPgBoss();
    await boss.unschedule(this.config.queueName, key);

    logger.info("pg-boss schedule cancelled", {
      queueName: this.config.queueName,
      key,
    });
  }

  // ── Job management ───────────────────────────────────────────────

  /** Cancel one or more jobs by ID. */
  async cancelJobs(jobIds: string[]): Promise<void> {
    const boss = await startPgBoss();
    await boss.cancel(this.config.queueName, jobIds);
  }

  /** Retry one or more failed/cancelled jobs by ID. */
  async retryJobs(jobIds: string[]): Promise<void> {
    const boss = await startPgBoss();
    await boss.retry(this.config.queueName, jobIds);
  }

  /** Delete one or more jobs by ID. */
  async deleteJobs(jobIds: string[]): Promise<void> {
    const boss = await startPgBoss();
    await boss.deleteJob(this.config.queueName, jobIds);
  }

  // ── Observability ─────────────────────────────────────────────────

  /**
   * Fetch jobs from the queue (for inspection / DLQ retry).
   * pg-boss fetch returns up to batchSize jobs without mutating their state.
   */
  async fetch(options?: {
    batchSize?: number;
    includeMetadata?: boolean;
  }): Promise<Job<unknown>[]> {
    const boss = await startPgBoss();
    const jobs = await boss.fetch<unknown>(
      this.config.queueName,
      options ?? {},
    );
    return jobs ?? [];
  }

  /** Get queue statistics (waiting, active, completed, failed counts + config). */
  async getStats() {
    const boss = await startPgBoss();
    return boss.getQueueStats(this.config.queueName);
  }

  /** Get the full queue info (name, policy, created/updated timestamps). */
  async getQueueInfo() {
    const boss = await startPgBoss();
    return boss.getQueue(this.config.queueName);
  }

  /** Fetch a single job by its ID, including metadata/state. */
  async getJobById<TData extends object = PgBossJobEnvelope<TPayload>>(
    jobId: string,
  ): Promise<JobWithMetadata<TData> | null> {
    const boss = await startPgBoss();
    return boss.getJobById<TData>(this.config.queueName, jobId);
  }

  /** Find jobs in this queue with optional filters. */
  async findJobs<TData extends object = PgBossJobEnvelope<TPayload>>(
    options?: FindJobsOptions,
  ): Promise<JobWithMetadata<TData>[]> {
    const boss = await startPgBoss();
    return boss.findJobs<TData>(this.config.queueName, options);
  }

  /** Convenience helper for UIs that only need the current state. */
  async getJobState(jobId: string): Promise<JobWithMetadata["state"] | null> {
    const job = await this.getJobById(jobId);
    return job?.state ?? null;
  }

  /** Delete all jobs from the queue. Useful for integration tests. */
  async deleteAllJobs(): Promise<void> {
    const boss = await startPgBoss();
    await boss.deleteAllJobs(this.config.queueName);
  }
}
