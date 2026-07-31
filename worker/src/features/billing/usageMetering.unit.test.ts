import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cronUpsert: vi.fn(),
  cronClaim: vi.fn(),
  cronUpdate: vi.fn(),
  organizationFindMany: vi.fn(),
  backupUpsert: vi.fn(),
  backupUpdate: vi.fn(),
  traceCounts: vi.fn(),
  observationCounts: vi.fn(),
  scoreCounts: vi.fn(),
  exactCounts: vi.fn(),
  meterCreate: vi.fn(),
  backOff: vi.fn(),
}));

vi.mock("@langfuse/shared", () => ({
  parseDbOrg: (organization: unknown) => organization,
  Prisma: { DbNull: "DbNull" },
}));

vi.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    cronJobs: {
      upsert: mocks.cronUpsert,
      updateMany: mocks.cronClaim,
      update: mocks.cronUpdate,
    },
    organization: { findMany: mocks.organizationFindMany },
    billingMeterBackup: {
      upsert: mocks.backupUpsert,
      update: mocks.backupUpdate,
    },
  },
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langfuse/shared/src/server")>()),
  getTraceCountsByProjectInCreationInterval: mocks.traceCounts,
  getObservationCountsByProjectInCreationInterval: mocks.observationCounts,
  getScoreCountsByProjectInCreationInterval: mocks.scoreCounts,
  getBillingUnitCountForProjects: mocks.exactCounts,
  logger: { info: vi.fn() },
}));

vi.mock("stripe", () => ({
  default: class Stripe {
    billing = { meterEvents: { create: mocks.meterCreate } };
  },
}));

vi.mock("exponential-backoff", () => ({
  backOff: mocks.backOff,
}));

vi.mock("../../env", () => ({
  env: { STRIPE_SECRET_KEY: "sk_test" },
}));

import {
  buildMeteringSegments,
  processCloudUsageMetering,
} from "./usageMetering";

const now = new Date("2026-07-30T12:10:00.000Z");
const intervalStart = new Date("2026-07-30T10:00:00.000Z");
const intervalEnd = new Date("2026-07-30T11:00:00.000Z");

function meteredOrganization() {
  return {
    id: "org_test",
    cloudConfig: {
      stripe: {
        customerId: "cus_test",
        activeSubscriptionId: "sub_test",
        resolvedPlan: "Pro",
        meteringStartAt: "2026-07-30T09:37:00.000Z",
      },
    },
    cloudBillingCycleAnchor: new Date("2026-07-30T09:37:00.000Z"),
    projects: [{ id: "project_test" }],
  };
}

describe("processCloudUsageMetering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    mocks.cronUpsert.mockResolvedValue({
      name: "cloud-usage-metering-hourly",
      state: "queued",
      lastRun: intervalStart,
      jobStartedAt: null,
    });
    mocks.cronClaim.mockResolvedValue({ count: 1 });
    mocks.cronUpdate.mockResolvedValue({});
    mocks.organizationFindMany.mockResolvedValue([meteredOrganization()]);
    mocks.traceCounts.mockResolvedValue([
      { projectId: "project_test", count: 1 },
    ]);
    mocks.observationCounts.mockResolvedValue([
      { projectId: "project_test", count: 2 },
    ]);
    mocks.scoreCounts.mockResolvedValue([
      { projectId: "project_test", count: 3 },
    ]);
    mocks.exactCounts.mockResolvedValue({
      traces: 0,
      observations: 0,
      scores: 0,
      total: 0,
    });
    mocks.backupUpsert.mockResolvedValue({ submittedAt: null });
    mocks.backupUpdate.mockResolvedValue({});
    mocks.meterCreate.mockResolvedValue({});
    mocks.backOff.mockImplementation(async (operation) => operation());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops when another worker already claimed the interval", async () => {
    mocks.cronClaim.mockResolvedValue({ count: 0 });

    await expect(processCloudUsageMetering()).resolves.toEqual({
      processedOrganizations: 0,
      units: 0,
      caughtUp: false,
    });
    expect(mocks.organizationFindMany).not.toHaveBeenCalled();
    expect(mocks.cronUpdate).not.toHaveBeenCalled();
  });

  it("advances the checkpoint without submitting a zero-value event", async () => {
    mocks.traceCounts.mockResolvedValue([]);
    mocks.observationCounts.mockResolvedValue([]);
    mocks.scoreCounts.mockResolvedValue([]);

    await expect(processCloudUsageMetering()).resolves.toMatchObject({
      processedOrganizations: 1,
      units: 0,
    });
    expect(mocks.backupUpsert).not.toHaveBeenCalled();
    expect(mocks.meterCreate).not.toHaveBeenCalled();
    expect(mocks.cronUpdate).toHaveBeenCalledWith({
      where: { name: "cloud-usage-metering-hourly" },
      data: {
        lastRun: intervalEnd,
        state: "queued",
        jobStartedAt: null,
      },
    });
  });

  it("does not advance the checkpoint when Stripe submission fails", async () => {
    const stripeError = new Error("Stripe unavailable");
    mocks.meterCreate.mockRejectedValue(stripeError);

    await expect(processCloudUsageMetering()).rejects.toThrow(stripeError);
    expect(mocks.backupUpdate).not.toHaveBeenCalled();
    expect(mocks.cronUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.cronUpdate).toHaveBeenCalledWith({
      where: { name: "cloud-usage-metering-hourly" },
      data: { state: "queued", jobStartedAt: null },
    });
  });

  it("does not submit an interval whose backup is already committed", async () => {
    mocks.backupUpsert.mockResolvedValue({
      submittedAt: new Date("2026-07-30T11:01:00.000Z"),
    });

    await expect(processCloudUsageMetering()).resolves.toMatchObject({
      processedOrganizations: 1,
      units: 6,
    });
    expect(mocks.meterCreate).not.toHaveBeenCalled();
    expect(mocks.backupUpdate).not.toHaveBeenCalled();
    expect(mocks.cronUpdate).toHaveBeenCalledWith({
      where: { name: "cloud-usage-metering-hourly" },
      data: {
        lastRun: intervalEnd,
        state: "queued",
        jobStartedAt: null,
      },
    });
  });
});

describe("buildMeteringSegments", () => {
  it("excludes usage before a subscription starts mid-hour", () => {
    expect(
      buildMeteringSegments({
        intervalStart: new Date("2026-07-30T10:00:00.000Z"),
        intervalEnd: new Date("2026-07-30T11:00:00.000Z"),
        meteringStartAt: new Date("2026-07-30T10:37:00.000Z"),
        meteringEndAt: null,
        cycleAnchor: new Date("2026-07-30T10:37:00.000Z"),
      }),
    ).toEqual([
      {
        start: new Date("2026-07-30T10:37:00.000Z"),
        end: new Date("2026-07-30T11:00:00.000Z"),
      },
    ]);
  });

  it("splits an active subscription interval at a monthly cycle boundary", () => {
    expect(
      buildMeteringSegments({
        intervalStart: new Date("2026-08-30T10:00:00.000Z"),
        intervalEnd: new Date("2026-08-30T11:00:00.000Z"),
        meteringStartAt: new Date("2026-07-30T10:37:00.000Z"),
        meteringEndAt: null,
        cycleAnchor: new Date("2026-08-30T10:37:00.000Z"),
      }),
    ).toEqual([
      {
        start: new Date("2026-08-30T10:00:00.000Z"),
        end: new Date("2026-08-30T10:37:00.000Z"),
      },
      {
        start: new Date("2026-08-30T10:37:00.000Z"),
        end: new Date("2026-08-30T11:00:00.000Z"),
      },
    ]);
  });
});
