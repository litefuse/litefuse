/** @jest-environment node */

import { prisma } from "@langfuse/shared/src/db";
import {
  getBillingCycleStart,
  getObservationCountOfProjectsSinceCreationDate,
  getScoreCountOfProjectsSinceCreationDate,
  getTraceCountOfProjectsSinceCreationDate,
  logger,
} from "@langfuse/shared/src/server";
import { getFreshBillingUsage } from "./billingUsageService";

jest.mock("@langfuse/shared/src/db", () => ({
  prisma: { organization: { update: jest.fn() } },
}));

jest.mock("@langfuse/shared/src/server", () => ({
  getBillingCycleStart: jest.fn(),
  getObservationCountOfProjectsSinceCreationDate: jest.fn(),
  getScoreCountOfProjectsSinceCreationDate: jest.fn(),
  getTraceCountOfProjectsSinceCreationDate: jest.fn(),
  logger: { debug: jest.fn(), warn: jest.fn() },
  redis: undefined,
}));

const mockedGetBillingCycleStart = jest.mocked(getBillingCycleStart);
const mockedGetObservationCount = jest.mocked(
  getObservationCountOfProjectsSinceCreationDate,
);
const mockedGetScoreCount = jest.mocked(
  getScoreCountOfProjectsSinceCreationDate,
);
const mockedGetTraceCount = jest.mocked(
  getTraceCountOfProjectsSinceCreationDate,
);
const mockedUpdateOrganization = jest.mocked(prisma.organization.update);
const mockedLoggerWarn = jest.mocked(logger.warn);

const now = new Date("2026-07-22T10:36:55.000Z");
const cycleStart = new Date("2026-07-22T00:00:00.000Z");

function organization(updatedAt: Date | null = null) {
  return {
    id: "org_test",
    name: "Test organization",
    createdAt: new Date("2026-01-22T00:00:00.000Z"),
    updatedAt: now,
    cloudConfig: {},
    metadata: {},
    cloudBillingCycleAnchor: cycleStart,
    cloudBillingCycleUpdatedAt: updatedAt,
    cloudCurrentCycleUsage: 7,
    cloudFreeTierUsageThresholdState: null,
    aiFeaturesEnabled: false,
    projects: [{ id: "project_a" }, { id: "project_b" }],
  };
}

describe("getFreshBillingUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetBillingCycleStart.mockReturnValue(cycleStart);
    mockedUpdateOrganization.mockResolvedValue({} as never);
  });

  it("recalculates stale usage for only the organization's projects", async () => {
    mockedGetTraceCount.mockResolvedValue(2);
    mockedGetObservationCount.mockResolvedValue(3);
    mockedGetScoreCount.mockResolvedValue(4);

    await expect(
      getFreshBillingUsage({ organization: organization(), now }),
    ).resolves.toEqual({ currentUnits: 9, updatedAt: now });

    const expectedQuery = {
      projectIds: ["project_a", "project_b"],
      start: cycleStart,
    };
    expect(mockedGetTraceCount).toHaveBeenCalledWith(expectedQuery);
    expect(mockedGetObservationCount).toHaveBeenCalledWith(expectedQuery);
    expect(mockedGetScoreCount).toHaveBeenCalledWith(expectedQuery);
    expect(mockedUpdateOrganization).toHaveBeenCalledWith({
      where: { id: "org_test" },
      data: {
        cloudCurrentCycleUsage: 9,
        cloudBillingCycleUpdatedAt: now,
      },
    });
  });

  it("uses the cached value while it is fresh", async () => {
    const updatedAt = new Date(now.getTime() - 60_000);

    await expect(
      getFreshBillingUsage({ organization: organization(updatedAt), now }),
    ).resolves.toEqual({ currentUnits: 7, updatedAt });

    expect(mockedGetTraceCount).not.toHaveBeenCalled();
    expect(mockedUpdateOrganization).not.toHaveBeenCalled();
  });

  it("keeps the cached value when the analytics query fails", async () => {
    mockedGetTraceCount.mockRejectedValue(new Error("Doris unavailable"));
    mockedGetObservationCount.mockResolvedValue(3);
    mockedGetScoreCount.mockResolvedValue(4);

    await expect(
      getFreshBillingUsage({ organization: organization(), now }),
    ).resolves.toEqual({ currentUnits: 7, updatedAt: null });

    expect(mockedUpdateOrganization).not.toHaveBeenCalled();
    expect(mockedLoggerWarn).toHaveBeenCalledWith(
      "Unable to refresh organization billing usage",
      expect.objectContaining({ orgId: "org_test" }),
    );
  });
});
