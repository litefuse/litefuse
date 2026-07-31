import { prisma, type Organization } from "@langfuse/shared/src/db";
import {
  BILLING_METER_EVENT_NAME,
  CLOUD_USAGE_METERING_CRON_NAME,
  getBillingCycleStart,
  getBillingUnitCountForProjects,
  logger,
} from "@langfuse/shared/src/server";

const BILLING_USAGE_CACHE_MS = 5 * 60 * 1000;

type BillingUsageOrganization = Organization & {
  projects: Array<{ id: string }>;
};

type BillingUsageResult = {
  currentUnits: number;
  reportedUnits: number | null;
  pendingUnits: number | null;
  reportedThrough: Date | null;
  updatedAt: Date | null;
};

export async function getFreshBillingUsage(params: {
  organization: BillingUsageOrganization;
  now?: Date;
}): Promise<{ currentUnits: number; updatedAt: Date | null }> {
  const { organization } = params;
  const now = params.now ?? new Date();
  const cachedUsage = organization.cloudCurrentCycleUsage ?? 0;
  const cachedAt = organization.cloudBillingCycleUpdatedAt;

  if (cachedAt && now.getTime() - cachedAt.getTime() < BILLING_USAGE_CACHE_MS) {
    return { currentUnits: cachedUsage, updatedAt: cachedAt };
  }

  const projectIds = organization.projects.map((project) => project.id);

  try {
    const start = getBillingCycleStart(organization, now);
    const { total: currentUnits } = await getBillingUnitCountForProjects({
      projectIds,
      start,
      end: now,
    });

    return { currentUnits, updatedAt: now };
  } catch (error) {
    logger.warn("Unable to refresh organization billing usage", {
      orgId: organization.id,
      error,
    });
    return { currentUnits: cachedUsage, updatedAt: cachedAt };
  }
}

export async function getPaidBillingUsage(params: {
  organization: BillingUsageOrganization;
  customerId: string;
  now?: Date;
}): Promise<BillingUsageResult> {
  const now = params.now ?? new Date();
  const cycleStart = getBillingCycleStart(params.organization, now);
  const cron = await prisma.cronJobs.findUnique({
    where: { name: CLOUD_USAGE_METERING_CRON_NAME },
    select: { lastRun: true },
  });
  const reportedThrough = cron?.lastRun
    ? new Date(
        Math.min(
          now.getTime(),
          Math.max(cycleStart.getTime(), cron.lastRun.getTime()),
        ),
      )
    : null;
  const committedEnd = reportedThrough ?? cycleStart;
  const [reported, pending] = await Promise.all([
    prisma.billingMeterBackup.aggregate({
      where: {
        stripeCustomerId: params.customerId,
        meterId: BILLING_METER_EVENT_NAME,
        submittedAt: { not: null },
        startTime: { gte: cycleStart },
        endTime: { lte: committedEnd },
      },
      _sum: { aggregatedValue: true },
    }),
    getBillingUnitCountForProjects({
      projectIds: params.organization.projects.map((project) => project.id),
      start: committedEnd,
      end: now,
    }),
  ]);
  const reportedUnits = reported._sum.aggregatedValue ?? 0;
  const pendingUnits = pending.total;
  return {
    currentUnits: reportedUnits + pendingUnits,
    reportedUnits,
    pendingUnits,
    reportedThrough,
    updatedAt: now,
  };
}
