import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedServerMocks = vi.hoisted(() => ({
  registerPgBossWorker: vi.fn(),
  ensurePgBossSchedules: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    registerPgBossWorker: sharedServerMocks.registerPgBossWorker,
    ensurePgBossSchedules: sharedServerMocks.ensurePgBossSchedules,
  };
});

import {
  PG_BOSS_SCHEDULE_DEFINITIONS,
  QueueName,
} from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";
import {
  getEnabledPgBossSchedules,
  registerPgBossEventProcessor,
  registerPgBossScheduledProcessor,
  startPgBossScheduledJobs,
} from "@/src/server/background/queues/pgBossScheduledJobs";

const schedule = (queueName: QueueName) =>
  PG_BOSS_SCHEDULE_DEFINITIONS.find(
    (definition) => definition.queueName === queueName,
  );

const originalEnv = { ...env };

const disableAllSchedules = () => {
  env.LITEFUSE_PG_BOSS_ENABLED = "true";
  env.QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED = "false";
  env.QUEUE_CONSUMER_MIXPANEL_INTEGRATION_QUEUE_IS_ENABLED = "false";
  env.QUEUE_CONSUMER_BLOB_STORAGE_INTEGRATION_QUEUE_IS_ENABLED = "false";
  env.QUEUE_CONSUMER_DEAD_LETTER_RETRY_QUEUE_IS_ENABLED = "false";
  env.LITEFUSE_S3_CORE_DATA_EXPORT_IS_ENABLED = "false";
};

afterEach(() => {
  Object.assign(env, originalEnv);
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// PG_BOSS_SCHEDULE_DEFINITIONS — data integrity
// ═══════════════════════════════════════════════════════════════════════

describe("PG_BOSS_SCHEDULE_DEFINITIONS", () => {
  it("maps migrated BullMQ repeatable jobs to pg-boss schedule definitions", () => {
    expect(schedule(QueueName.DeadLetterRetryQueue)).toMatchObject({
      jobName: "dead-letter-retry-job",
      cron: "*/10 * * * *",
    });
    expect(schedule(QueueName.BlobStorageIntegrationQueue)).toMatchObject({
      jobName: "blobstorage-integration-job",
      cron: "20 * * * *",
      key: "blob-storage-integration-hourly",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getEnabledPgBossSchedules
// ═══════════════════════════════════════════════════════════════════════

describe("getEnabledPgBossSchedules", () => {
  it("returns empty when pg-boss is disabled", () => {
    disableAllSchedules();
    env.LITEFUSE_PG_BOSS_ENABLED = "false";
    env.QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED = "true";
    expect(getEnabledPgBossSchedules()).toEqual([]);
  });

  it("returns enabled schedules based on env flags", () => {
    disableAllSchedules();
    env.QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED = "true";
    expect(getEnabledPgBossSchedules().map((s) => s.queueName)).toEqual([
      QueueName.PostHogIntegrationQueue,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// startPgBossScheduledJobs
// ═══════════════════════════════════════════════════════════════════════

describe("startPgBossScheduledJobs", () => {
  it("ensures schedules and registers workers for enabled cron queues", async () => {
    disableAllSchedules();
    env.QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED = "true";

    const handler = vi.fn();
    await startPgBossScheduledJobs({
      [QueueName.PostHogIntegrationQueue]: handler,
    });

    expect(sharedServerMocks.ensurePgBossSchedules).toHaveBeenCalledWith([
      expect.objectContaining({
        queueName: QueueName.PostHogIntegrationQueue,
      }),
    ]);
    expect(sharedServerMocks.registerPgBossWorker).toHaveBeenCalledWith(
      QueueName.PostHogIntegrationQueue,
      expect.objectContaining({ localConcurrency: 1 }),
      handler,
    );
  });

  it("skips registration when no schedules are enabled", async () => {
    disableAllSchedules();
    await startPgBossScheduledJobs({});
    expect(sharedServerMocks.ensurePgBossSchedules).not.toHaveBeenCalled();
  });

  it("warns but continues when a handler is missing for an enabled schedule", async () => {
    disableAllSchedules();
    env.QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED = "true";

    // No handler provided for PostHogIntegrationQueue
    await startPgBossScheduledJobs({});

    expect(sharedServerMocks.ensurePgBossSchedules).toHaveBeenCalled();
    // Worker should NOT be registered without a handler
    expect(sharedServerMocks.registerPgBossWorker).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// registerPgBossScheduledProcessor
// ═══════════════════════════════════════════════════════════════════════

describe("registerPgBossScheduledProcessor", () => {
  it("calls registerPgBossWorker with default scheduled options", async () => {
    const handler = vi.fn();
    await registerPgBossScheduledProcessor(
      QueueName.CoreDataS3ExportQueue,
      handler,
    );

    expect(sharedServerMocks.registerPgBossWorker).toHaveBeenCalledWith(
      QueueName.CoreDataS3ExportQueue,
      expect.objectContaining({
        localConcurrency: 1,
        pollingIntervalSeconds: 2,
      }),
      handler,
    );
  });

  it("passes custom concurrency", async () => {
    const handler = vi.fn();
    await registerPgBossScheduledProcessor(
      QueueName.CoreDataS3ExportQueue,
      handler,
      { localConcurrency: 3 },
    );

    expect(sharedServerMocks.registerPgBossWorker).toHaveBeenCalledWith(
      QueueName.CoreDataS3ExportQueue,
      expect.objectContaining({ localConcurrency: 3 }),
      handler,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// registerPgBossEventProcessor
// ═══════════════════════════════════════════════════════════════════════

describe("registerPgBossEventProcessor", () => {
  it("calls registerPgBossWorker with event-driven defaults", async () => {
    const handler = vi.fn();
    await registerPgBossEventProcessor(QueueName.TraceDelete, handler);

    expect(sharedServerMocks.registerPgBossWorker).toHaveBeenCalledWith(
      QueueName.TraceDelete,
      expect.objectContaining({
        localConcurrency: 1,
        pollingIntervalSeconds: 1,
      }),
      handler,
    );
  });

  it("passes custom worker options", async () => {
    const handler = vi.fn();
    await registerPgBossEventProcessor(QueueName.TraceUpsert, handler, {
      localConcurrency: 4,
      pollingIntervalSeconds: 2,
    });

    expect(sharedServerMocks.registerPgBossWorker).toHaveBeenCalledWith(
      QueueName.TraceUpsert,
      expect.objectContaining({
        localConcurrency: 4,
        pollingIntervalSeconds: 2,
      }),
      handler,
    );
  });

  it("passes the pg-boss WorkHandler through unchanged", async () => {
    const handler = vi.fn();
    await registerPgBossEventProcessor(QueueName.ProjectDelete, handler);

    const [, , passedHandler] =
      sharedServerMocks.registerPgBossWorker.mock.calls[0];
    expect(passedHandler).toBe(handler);
  });

  it("handler receives pg-boss jobs and can dispatch to processor", async () => {
    let capturedHandler: ((jobs: any[]) => Promise<void>) | undefined;
    sharedServerMocks.registerPgBossWorker.mockImplementation(
      async (_name, _opts, handler) => {
        capturedHandler = handler;
      },
    );

    const processor = vi.fn().mockResolvedValue(undefined);
    await registerPgBossEventProcessor(QueueName.ScoreDelete, async (jobs) => {
      for (const j of jobs) {
        await processor(j.data.payload);
      }
    });

    await capturedHandler!([
      {
        id: "job-1",
        name: "score-delete",
        data: {
          name: "score-delete",
          timestamp: new Date().toISOString(),
          payload: { projectId: "p1", scoreIds: ["s1", "s2"] },
        },
      },
    ]);

    expect(processor).toHaveBeenCalledWith({
      projectId: "p1",
      scoreIds: ["s1", "s2"],
    });
  });
});
