import { afterEach, describe, expect, it, vi } from "vitest";

const sharedServerMocks = vi.hoisted(() => ({
  registerPgBossWorker: vi.fn().mockResolvedValue("worker-id"),
  ensurePgBossEventQueue: vi.fn().mockResolvedValue(undefined),
  getPgBossQueueConfig: vi.fn().mockReturnValue({
    queueName: "batch-action-queue",
    queueOptions: {},
    defaultWorkOptions: {
      localConcurrency: 1,
      pollingIntervalSeconds: 0.25,
      batchSize: 25,
    },
  }),
  getPgBoss: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    registerPgBossWorker: sharedServerMocks.registerPgBossWorker,
    ensurePgBossEventQueue: sharedServerMocks.ensurePgBossEventQueue,
    getPgBossQueueConfig: sharedServerMocks.getPgBossQueueConfig,
    getPgBoss: sharedServerMocks.getPgBoss,
  };
});

import { QueueName } from "@langfuse/shared/src/server";
import { WorkerManager } from "@/src/server/background/queues/workerManager";

afterEach(() => {
  WorkerManager.close();
  WorkerManager.__testReset();
  vi.clearAllMocks();
});

describe("WorkerManager queue defaults", () => {
  it("passes queue-config polling interval and batch size to polling workers", async () => {
    WorkerManager.register(
      QueueName.BatchActionQueue,
      vi.fn().mockResolvedValue(undefined),
      {
        localConcurrency: 3,
      },
    );

    await vi.waitFor(() => {
      expect(sharedServerMocks.registerPgBossWorker).toHaveBeenCalled();
    });

    expect(sharedServerMocks.registerPgBossWorker).toHaveBeenCalledWith(
      QueueName.BatchActionQueue,
      expect.objectContaining({
        localConcurrency: 3,
        pollingIntervalSeconds: 0.25,
        batchSize: 25,
      }),
      expect.any(Function),
    );
  });

  it("drains immediately to the next fetch after a short-circuit batch", async () => {
    const fetchCalls: number[] = [];
    const completeCalls: string[][] = [];
    const processedJobIds: string[] = [];

    sharedServerMocks.getPgBoss.mockResolvedValue({
      fetch: vi.fn().mockImplementation(async () => {
        fetchCalls.push(Date.now());
        if (fetchCalls.length === 1) {
          return [
            {
              id: "job-1",
              name: "batch-action-processing-job",
              data: {
                id: "job-1",
                name: "batch-action-processing-job",
                timestamp: new Date().toISOString(),
                payload: {
                  projectId: "project-1",
                  actionId: "trace-delete",
                },
              },
            },
          ];
        }

        return [];
      }),
      complete: vi
        .fn()
        .mockImplementation(async (_queue: string, ids: string[]) => {
          completeCalls.push(ids);
        }),
      fail: vi.fn().mockResolvedValue(undefined),
    });

    const processor = vi.fn().mockImplementation(async (job: any) => {
      processedJobIds.push(job.data.id);
      return undefined;
    });

    WorkerManager.register(QueueName.BatchActionQueue, processor, {
      consumeMode: "drain",
      localConcurrency: 1,
      pollingIntervalSeconds: 60,
      batchSize: 1,
    });

    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
      expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    });

    expect(sharedServerMocks.registerPgBossWorker).not.toHaveBeenCalled();
    expect(processedJobIds).toEqual(["job-1"]);
    expect(completeCalls).toEqual([["job-1"]]);
  });

  it("rejects drain mode when rate limiting is configured", () => {
    expect(() =>
      WorkerManager.register(
        QueueName.BatchActionQueue,
        vi.fn().mockResolvedValue(undefined),
        {
          consumeMode: "drain",
          rateLimit: { max: 1, duration: 1_000 },
        },
      ),
    ).toThrow(
      "Drain consume mode does not support rate limiting for queue batch-action-queue",
    );
  });

  it("settles drain batches per job instead of failing the whole batch", async () => {
    const completedCalls: string[][] = [];
    const failedCalls: Array<{
      ids: string[];
      error: Record<string, unknown>;
    }> = [];

    sharedServerMocks.getPgBoss.mockResolvedValue({
      fetch: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "job-1",
            name: "batch-action-processing-job",
            data: {
              id: "job-1",
              name: "batch-action-processing-job",
              timestamp: new Date().toISOString(),
              payload: { projectId: "project-1", actionId: "trace-delete" },
            },
          },
          {
            id: "job-2",
            name: "batch-action-processing-job",
            data: {
              id: "job-2",
              name: "batch-action-processing-job",
              timestamp: new Date().toISOString(),
              payload: { projectId: "project-1", actionId: "trace-delete" },
            },
          },
        ])
        .mockResolvedValue([]),
      complete: vi
        .fn()
        .mockImplementation(async (_queue: string, ids: string[]) => {
          completedCalls.push(ids);
        }),
      fail: vi
        .fn()
        .mockImplementation(
          async (
            _queue: string,
            ids: string[],
            error: Record<string, unknown>,
          ) => {
            failedCalls.push({ ids, error });
          },
        ),
    });

    const processor = vi.fn().mockImplementation(async (job: any) => {
      if (job.data.id === "job-2") {
        throw new Error("boom");
      }
    });

    WorkerManager.register(QueueName.BatchActionQueue, processor, {
      consumeMode: "drain",
      localConcurrency: 1,
      pollingIntervalSeconds: 60,
      batchSize: 2,
    });

    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(2);
      expect(completedCalls).toEqual([["job-1"]]);
      expect(failedCalls).toHaveLength(1);
    });

    expect(failedCalls[0]).toMatchObject({
      ids: ["job-2"],
      error: expect.objectContaining({
        message: "boom",
        name: "Error",
      }),
    });
  });
});
