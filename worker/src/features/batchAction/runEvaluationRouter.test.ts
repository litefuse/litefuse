import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/env.mjs", () => ({
  env: {
    LITEFUSE_ENABLE_EVENTS_TABLE_FLAGS: "true",
    LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT: 1000,
  },
}));

vi.mock("@/src/features/audit-logs/auditLog", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@langfuse/shared/src/server", async () => {
  const actual = await vi.importActual<object>("@langfuse/shared/src/server");
  return {
    ...actual,
    getPgBossQueue: vi.fn(() => ({
      send: vi.fn().mockResolvedValue("mock-job-id"),
    })),
    getObservationsCountFromEventsTable: vi.fn(),
    getTracesTableCount: vi.fn(),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    },
  };
});

import {
  ActionId,
  BatchActionStatus,
  BatchEvalSourceTable,
  BatchTableNames,
  EvalTargetObject,
} from "@langfuse/shared";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import {
  getObservationsCountFromEventsTable,
  getPgBossQueue,
  getTracesTableCount,
  QueueJobs,
  QueueName,
} from "@langfuse/shared/src/server";
import { runEvaluationRouter } from "@/src/features/batch-actions/server/runEvaluationRouter";

const session = {
  user: {
    id: "user-1",
    admin: false,
    organizations: [
      {
        id: "org-1",
        name: "Org 1",
        role: "OWNER",
        plan: "cloud:hobby",
        cloudConfig: undefined,
        metadata: {},
        projects: [
          {
            id: "project-1",
            role: "ADMIN",
            retentionDays: 30,
            deletedAt: null,
            name: "Project 1",
            metadata: {},
          },
        ],
      },
    ],
    featureFlags: {
      templateFlag: true,
    },
  },
  orgId: "org-1",
  orgRole: "OWNER",
  projectId: "project-1",
  projectRole: "ADMIN",
};

const baseQuery = {
  filter: [],
  orderBy: {
    column: "startTime",
    order: "DESC" as const,
  },
};

const makeCtx = () => {
  const jobConfigurationFindMany = vi.fn();
  const batchActionCreate = vi.fn();

  return {
    ctx: {
      session,
      prisma: {
        jobConfiguration: {
          findMany: jobConfigurationFindMany,
        },
        batchAction: {
          create: batchActionCreate,
        },
      },
    },
    mocks: {
      jobConfigurationFindMany,
      batchActionCreate,
    },
  };
};

describe("runEvaluationRouter.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an observation batch action for events selections", async () => {
    const { ctx, mocks } = makeCtx();

    mocks.jobConfigurationFindMany.mockResolvedValue([{ id: "eval-1" }]);
    vi.mocked(getObservationsCountFromEventsTable).mockResolvedValueOnce(2);
    mocks.batchActionCreate.mockResolvedValue({
      id: "batch-action-1",
      projectId: "project-1",
    });

    const result = await runEvaluationRouter.createCaller(ctx as never).create({
      projectId: "project-1",
      query: baseQuery,
      evaluatorIds: ["eval-1"],
      sourceTable: BatchEvalSourceTable.EVENTS,
    });

    expect(result).toEqual({ id: "batch-action-1" });
    expect(mocks.jobConfigurationFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["eval-1"] },
        projectId: "project-1",
        targetObject: EvalTargetObject.EVENT,
      },
      select: { id: true },
    });
    expect(getObservationsCountFromEventsTable).toHaveBeenCalledWith({
      projectId: "project-1",
      filter: [],
      searchQuery: undefined,
      searchType: undefined,
      selectIOAndMetadata: false,
    });
    expect(mocks.batchActionCreate).toHaveBeenCalledWith({
      data: {
        projectId: "project-1",
        userId: "user-1",
        actionType: ActionId.ObservationBatchEvaluation,
        tableName: BatchTableNames.Events,
        status: BatchActionStatus.Queued,
        query: baseQuery,
        config: {
          evaluatorIds: ["eval-1"],
        },
      },
    });
    expect(auditLog).toHaveBeenCalled();
    expect(getPgBossQueue).toHaveBeenCalledWith(QueueName.BatchActionQueue);
    expect(
      vi.mocked(getPgBossQueue).mock.results[0]?.value.send,
    ).toHaveBeenCalledWith(
      QueueJobs.BatchActionProcessingJob,
      expect.objectContaining({
        actionId: ActionId.ObservationBatchEvaluation,
        batchActionId: "batch-action-1",
        projectId: "project-1",
        evaluatorIds: ["eval-1"],
      }),
      expect.objectContaining({
        singletonKey: "batch-action-1",
      }),
    );
  });

  it("creates a trace batch action without the events table path", async () => {
    const { ctx, mocks } = makeCtx();

    mocks.jobConfigurationFindMany.mockResolvedValue([{ id: "trace-eval-1" }]);
    vi.mocked(getTracesTableCount).mockResolvedValueOnce(3);
    mocks.batchActionCreate.mockResolvedValue({
      id: "batch-action-2",
      projectId: "project-1",
    });

    const result = await runEvaluationRouter.createCaller(ctx as never).create({
      projectId: "project-1",
      query: {
        filter: [],
        orderBy: {
          column: "timestamp",
          order: "DESC",
        },
      },
      evaluatorIds: ["trace-eval-1"],
      sourceTable: BatchEvalSourceTable.TRACES,
    });

    expect(result).toEqual({ id: "batch-action-2" });
    expect(mocks.jobConfigurationFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["trace-eval-1"] },
        projectId: "project-1",
        targetObject: EvalTargetObject.TRACE,
      },
      select: { id: true },
    });
    expect(getTracesTableCount).toHaveBeenCalledWith({
      projectId: "project-1",
      filter: [],
      searchQuery: undefined,
      searchType: ["id"],
      orderBy: {
        column: "timestamp",
        order: "DESC",
      },
    });
    expect(mocks.batchActionCreate).toHaveBeenCalledWith({
      data: {
        projectId: "project-1",
        userId: "user-1",
        actionType: ActionId.TraceBatchEvaluation,
        tableName: BatchTableNames.Traces,
        status: BatchActionStatus.Queued,
        query: {
          filter: [],
          orderBy: {
            column: "timestamp",
            order: "DESC",
          },
        },
        config: {
          evaluatorIds: ["trace-eval-1"],
        },
      },
    });
  });

  it("rejects evaluators that do not match the selected source table target", async () => {
    const { ctx, mocks } = makeCtx();

    mocks.jobConfigurationFindMany.mockResolvedValue([]);

    await expect(
      runEvaluationRouter.createCaller(ctx as never).create({
        projectId: "project-1",
        query: baseQuery,
        evaluatorIds: ["trace-only-eval"],
        sourceTable: BatchEvalSourceTable.EVENTS,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("not observation-scoped"),
    });
  });
});
