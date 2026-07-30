/** @jest-environment node */

jest.mock("@langfuse/shared/src/server", () => {
  const originalModule = jest.requireActual("@langfuse/shared/src/server");
  return {
    ...originalModule,
    applyCommentFilters: jest.fn(),
    getTracesTable: jest.fn(),
  };
});

import type { Session } from "next-auth";
import { prisma } from "@langfuse/shared/src/db";
import { appRouter } from "@/src/server/api/root";
import { createInnerTRPCContext } from "@/src/server/api/trpc";
import {
  applyCommentFilters,
  getTracesTable,
} from "@langfuse/shared/src/server";

const mockGetTracesTable = jest.mocked(getTracesTable);
const mockApplyCommentFilters = jest.mocked(applyCommentFilters);

const projectId = "data-access-project";

const createSession = (admin: boolean): Session =>
  ({
    expires: "1",
    user: {
      id: "data-access-user",
      canCreateOrganizations: true,
      name: "Data Access User",
      organizations: [
        {
          id: "data-access-org",
          name: "Data Access Organization",
          role: "OWNER",
          plan: "cloud:hobby",
          cloudConfig: undefined,
          metadata: {},
          aiFeaturesEnabled: false,
          projects: [
            {
              id: projectId,
              role: "ADMIN",
              retentionDays: null,
              deletedAt: null,
              name: "Data Access Project",
              metadata: {},
              hasTraces: true,
            },
          ],
        },
      ],
      featureFlags: {
        excludeClickhouseRead: false,
        templateFlag: true,
      },
      admin,
    },
    environment: {
      enableExperimentalFeatures: false,
      selfHostedInstancePlan: null,
    },
  }) as Session;

const queryTraces = async (admin: boolean) => {
  const ctx = createInnerTRPCContext({
    session: createSession(admin),
    headers: {},
  });
  const caller = appRouter.createCaller({ ...ctx, prisma });

  await caller.traces.all({
    projectId,
    filter: [
      {
        column: "timestamp",
        type: "datetime",
        operator: ">=",
        value: new Date("2026-05-01T00:00:00.000Z"),
      },
    ],
    searchQuery: null,
    searchType: ["id"],
    page: 0,
    limit: 50,
    orderBy: {
      column: "timestamp",
      order: "DESC",
    },
  });
};

describe("traces data access limit", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    mockGetTracesTable.mockClear();
    mockApplyCommentFilters.mockClear();
    mockGetTracesTable.mockResolvedValue([]);
    mockApplyCommentFilters.mockImplementation(async ({ filterState }) => ({
      filterState,
      hasNoMatches: false,
      matchingIds: null,
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("enforces the Developer 30-day cutoff on the server", async () => {
    await queryTraces(false);

    expect(mockGetTracesTable).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.arrayContaining([
          {
            column: "timestamp",
            type: "datetime",
            operator: ">=",
            value: new Date("2026-06-30T12:00:00.000Z"),
          },
        ]),
      }),
    );
  });

  it("preserves the platform-admin entitlement bypass", async () => {
    await queryTraces(true);

    expect(mockGetTracesTable.mock.calls[0]?.[0].filter).toEqual([
      {
        column: "timestamp",
        type: "datetime",
        operator: ">=",
        value: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);
  });
});
