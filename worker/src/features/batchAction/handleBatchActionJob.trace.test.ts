import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  ActionId,
  BatchActionStatus,
  EvalTargetObject,
} from "@langfuse/shared";

vi.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    batchAction: {
      update: vi.fn().mockResolvedValue(undefined),
    },
    jobConfiguration: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "trace-config-1",
          projectId: "project-1",
          evalTemplateId: "template-1",
          scoreName: "quality",
          targetObject: EvalTargetObject.TRACE,
          variableMapping: [],
          status: "ACTIVE",
          blockedAt: null,
          delay: 0,
        },
      ]),
    },
    jobExecution: {
      upsert: vi.fn().mockImplementation(async ({ create }) => create),
    },
  },
}));

vi.mock("@langfuse/shared/src/server", async () => {
  const actual = await vi.importActual<object>("@langfuse/shared/src/server");
  return {
    ...actual,
    EvalExecutionQueue: {
      getInstance: vi.fn(() => ({
        add: vi.fn().mockResolvedValue(undefined),
      })),
    },
    CreateEvalQueue: {
      getInstance: vi.fn(),
    })),
    getCurrentSpan: vi.fn(() => null),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    },
    traceDeletionProcessor: vi.fn(),
  };
});

vi.mock(
  "@/src/server/background/features/database-read-stream/getDatabaseReadStream",
  () => ({
    getDatabaseReadStreamPaginated: vi.fn(),
    getTraceIdentifierStream: vi.fn(async function* () {
      yield {
        id: "trace-1",
        projectId: "project-1",
        timestamp: new Date("2026-06-23T00:00:00.000Z"),
      };
    }),
  }),
);

vi.mock(
  "@/src/server/background/features/database-read-stream/observation-stream",
  () => ({
    getObservationStream: vi.fn(),
  }),
);

vi.mock(
  "@/src/server/background/features/database-read-stream/event-stream",
  () => ({
    getEventsStreamForEval: vi.fn(),
    getEventsStreamForDataset: vi.fn(),
  }),
);

import { prisma } from "@langfuse/shared/src/db";
import {
  EvalExecutionQueue,
  QueueJobs,
  QueueName,
} from "@langfuse/shared/src/server";
import { handleBatchActionJob } from "@/src/server/background/features/batchAction/handleBatchActionJob";

describe("handleBatchActionJob trace batch evaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates trace eval executions and enqueues EvaluationExecution jobs", async () => {
    await handleBatchActionJob({
      payload: {
        actionId: ActionId.TraceBatchEvaluation,
        batchActionId: "batch-action-1",
        projectId: "project-1",
        cutoffCreatedAt: new Date("2026-06-23T00:00:00.000Z"),
        evaluatorIds: ["trace-config-1"],
        query: {
          filter: [],
          orderBy: {
            column: "timestamp",
            order: "DESC",
          },
        },
      },
    } as any);

    expect(prisma.jobExecution.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          jobConfigurationId: "trace-config-1",
          jobInputTraceId: "trace-1",
          jobInputTraceTimestamp: new Date("2026-06-23T00:00:00.000Z"),
          status: "PENDING",
        }),
      }),
    );

    const queue = (EvalExecutionQueue.getInstance as Mock).mock.results.find(
      (result) => result.type === "return",
    )?.value;
    expect(EvalExecutionQueue.getInstance).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      QueueName.EvaluationExecution,
      expect.objectContaining({
        name: QueueJobs.EvaluationExecution,
        payload: expect.objectContaining({
          projectId: "project-1",
          jobExecutionId: "trace-config-1:trace-1",
          delay: 0,
        }),
      }),
      expect.any(Object),
    );

    expect(prisma.batchAction.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BatchActionStatus.Completed,
          totalCount: 1,
          processedCount: 1,
          failedCount: 0,
        }),
      }),
    );
  });
});
