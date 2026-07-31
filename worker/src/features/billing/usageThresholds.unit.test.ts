import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  getBillingCycleStart: vi.fn(),
  getBillingUnitCountsForProjectWindows: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@langfuse/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langfuse/shared")>()),
  parseDbOrg: (organization: unknown) => organization,
}));

vi.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    organization: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
    organizationMembership: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@langfuse/shared/src/server", () => ({
  getBillingCycleEnd: vi.fn(),
  getBillingCycleStart: mocks.getBillingCycleStart,
  getBillingUnitCountsForProjectWindows:
    mocks.getBillingUnitCountsForProjectWindows,
  invalidateCachedOrgApiKeys: vi.fn(),
  logger: { info: mocks.loggerInfo, error: vi.fn() },
  sendUsageThresholdEmail: vi.fn(),
  traceException: vi.fn(),
}));

import { processUsageThresholds } from "./usageThresholds";

const referenceDate = new Date("2026-07-30T10:40:00.000Z");
const cycleAnchor = new Date("2026-07-01T10:37:00.000Z");
const updatedAt = new Date("2026-07-30T10:00:00.000Z");

function organization(
  cloudConfig: object,
  thresholdState: string | null = null,
) {
  return {
    id: "org_test",
    name: "Test",
    createdAt: cycleAnchor,
    updatedAt,
    cloudConfig,
    cloudBillingCycleAnchor: cycleAnchor,
    cloudBillingCycleUpdatedAt: null,
    cloudCurrentCycleUsage: null,
    cloudFreeTierUsageThresholdState: thresholdState,
    projects: [{ id: "project_test" }],
  };
}

describe("processUsageThresholds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBillingCycleStart.mockReturnValue(cycleAnchor);
    mocks.getBillingUnitCountsForProjectWindows.mockResolvedValue(
      new Map([["project_test", 50_000]]),
    );
  });

  it("discards a Developer result when the organization changed", async () => {
    mocks.findMany.mockResolvedValue([organization({})]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await processUsageThresholds(referenceDate);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "org_test",
        updatedAt,
        cloudBillingCycleAnchor: cycleAnchor,
      },
      data: {
        cloudCurrentCycleUsage: 50_000,
        cloudBillingCycleUpdatedAt: referenceDate,
        cloudFreeTierUsageThresholdState: null,
      },
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Skipping stale Developer usage threshold result",
      { orgId: "org_test" },
    );
  });

  it("does not overwrite the paid organization's usage snapshot", async () => {
    mocks.findMany.mockResolvedValue([
      organization(
        {
          stripe: {
            activeSubscriptionId: "sub_test",
            resolvedPlan: "Pro",
          },
        },
        "BLOCKED",
      ),
    ]);
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await processUsageThresholds(referenceDate);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "org_test",
        updatedAt,
        cloudBillingCycleAnchor: cycleAnchor,
      },
      data: { cloudFreeTierUsageThresholdState: null },
    });
    expect(mocks.getBillingUnitCountsForProjectWindows).toHaveBeenCalledWith({
      windows: [],
      end: referenceDate,
    });
  });
});
