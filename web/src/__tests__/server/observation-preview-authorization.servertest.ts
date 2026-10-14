import { observationsRouter } from "@/src/server/api/routers/observations";
import { traceRouter } from "@/src/server/api/routers/traces";
import { createTRPCRouter } from "@/src/server/api/trpc";
import { getTracePreviews } from "@/src/features/traces/server/tracePreviewService";
import { getObservationBatchPreviews } from "@/src/features/observations/server/observationBatchPreviews";
import { getTraceById } from "@langfuse/shared/src/server";
import { type Session } from "next-auth";

// Keep the real tRPC router and project authorization middleware. Only its
// external services/telemetry/serialization are replaced; no DB is initialized.
jest.mock("@/src/server/auth", () => ({ getServerAuthSession: jest.fn() }));
jest.mock("@/src/server/db", () => ({ DB: {} }));
jest.mock("@langfuse/shared/src/db", () => ({
  prisma: {},
  Role: { OWNER: "OWNER" },
}));
jest.mock("@/src/server/adminApiAuth", () => ({ AdminApiAuthService: {} }));
jest.mock("@/src/server/adminAccessWebhook", () => ({
  sendAdminAccessWebhook: jest.fn(),
}));
jest.mock("@/src/env.mjs", () => ({ env: {} }));
jest.mock("@/src/utils/superjson", () => ({ setUpSuperjson: jest.fn() }));
jest.mock("superjson", () => ({
  __esModule: true,
  default: {
    serialize: (value: unknown) => value,
    deserialize: (value: unknown) => value,
  },
}));
jest.mock("@baselime/trpc-opentelemetry-middleware", () => ({
  tracing:
    () =>
    ({ next }: { next: () => unknown }) =>
      next(),
}));
jest.mock("@langfuse/shared", () => {
  const { z } = jest.requireActual("zod/v4");
  return {
    BaseError: class BaseError extends Error {},
    // Unrelated trace endpoints are never called. The batch input schemas and
    // project middleware are the real implementations under test.
    TracingSearchType: z.unknown(),
    singleFilter: z.unknown(),
    timeFilter: z.unknown(),
    orderBy: z.unknown(),
    paginationZod: {},
    BatchActionQuerySchema: z.object({}),
  };
});
jest.mock("@/src/features/audit-logs/auditLog", () => ({}));
jest.mock("@/src/features/rbac/utils/checkProjectAccess", () => ({}));
jest.mock("@/src/features/scores/lib/aggregateScores", () => ({}));
jest.mock("@/src/features/table/server/createBatchActionJob", () => ({}));
jest.mock("@/src/features/entitlements/server/hasEntitlement", () => ({}));
jest.mock("@/src/features/traces/server/tracePreviewService", () => ({
  getTracePreviews: jest.fn(),
}));
jest.mock("@langfuse/shared/src/server", () => ({
  getTraceById: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  contextWithLangfuseProps: () =>
    jest.requireActual("@opentelemetry/api").context.active(),
}));
jest.mock(
  "@/src/features/observations/server/observationBatchPreviews",
  () => ({
    getObservationBatchPreviews: jest.fn(),
  }),
);

const input = {
  projectId: "project_a",
  observations: [
    {
      id: "span",
      traceId: "trace",
      startTime: new Date("2026-10-13T00:00:00Z"),
    },
  ],
};

const testRouter = createTRPCRouter({
  observations: observationsRouter,
  traces: traceRouter,
});

function caller(projectIds: string[] | null) {
  const session =
    projectIds === null
      ? null
      : ({
          user: {
            id: "user",
            admin: false,
            organizations: [
              {
                id: "org",
                role: "MEMBER",
                projects: projectIds.map((id) => ({ id, role: "VIEWER" })),
              },
            ],
          },
          // A forged cached projectId must not override membership/input checks.
          projectId: "untrusted_cached_project",
        } as unknown as Session);
  return testRouter.createCaller({
    session,
    headers: {},
    prisma: {},
    DB: {},
  } as unknown as Parameters<typeof testRouter.createCaller>[0]);
}

describe("observation batch preview project authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getObservationBatchPreviews).mockResolvedValue([]);
  });

  it.each([null, [], ["another_project"]])(
    "rejects a caller without membership (%j) before querying",
    async (projects) => {
      await expect(
        caller(projects).observations.batchPreviews(input),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(getObservationBatchPreviews).not.toHaveBeenCalled();
      expect(getTraceById).not.toHaveBeenCalled();
    },
  );

  it("authorizes the requested project once without loading a root trace", async () => {
    await expect(
      caller(["project_a"]).observations.batchPreviews(input),
    ).resolves.toEqual([]);
    expect(getObservationBatchPreviews).toHaveBeenCalledTimes(1);
    expect(getObservationBatchPreviews).toHaveBeenCalledWith({
      ...input,
      includeMetadata: false,
    });
    expect(getTraceById).not.toHaveBeenCalled();
  });

  it("validates the batch before executing its service", async () => {
    await expect(
      caller(["project_a"]).observations.batchPreviews({
        ...input,
        observations: [{ ...input.observations[0], traceId: "" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getObservationBatchPreviews).not.toHaveBeenCalled();
  });
});

describe("trace batch preview project authorization", () => {
  const traceInput = {
    projectId: "project_a",
    traces: [{ id: "trace", timestamp: input.observations[0].startTime }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getTracePreviews).mockResolvedValue([]);
  });

  it.each([null, [], ["another_project"]])(
    "rejects a caller without membership (%j) before querying",
    async (projects) => {
      await expect(
        caller(projects).traces.batchPreviews(traceInput),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(getTracePreviews).not.toHaveBeenCalled();
      expect(getTraceById).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, true])(
    "uses the authorized project and metadata visibility (%j)",
    async (includeMetadata) => {
      await expect(
        caller(["project_a"]).traces.batchPreviews({
          ...traceInput,
          includeMetadata,
        }),
      ).resolves.toEqual([]);
      expect(getTracePreviews).toHaveBeenCalledWith({
        ...traceInput,
        includeMetadata: includeMetadata ?? false,
      });
      expect(getTraceById).not.toHaveBeenCalled();
    },
  );

  it("rejects more than 1000 rows and invalid identities before querying", async () => {
    for (const traces of [
      Array.from({ length: 1001 }, () => traceInput.traces[0]),
      [{ ...traceInput.traces[0], id: "" }],
      [{ ...traceInput.traces[0], timestamp: new Date("invalid") }],
    ]) {
      await expect(
        caller(["project_a"]).traces.batchPreviews({ ...traceInput, traces }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(getTracePreviews).not.toHaveBeenCalled();
  });
});
