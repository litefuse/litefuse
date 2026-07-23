import { prisma, type Organization } from "@langfuse/shared/src/db";
import {
  getBillingCycleStart,
  getObservationCountOfProjectsSinceCreationDate,
  getScoreCountOfProjectsSinceCreationDate,
  getTraceCountOfProjectsSinceCreationDate,
  logger,
} from "@langfuse/shared/src/server";

const BILLING_USAGE_CACHE_MS = 5 * 60 * 1000;

type BillingUsageOrganization = Organization & {
  projects: Array<{ id: string }>;
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
    const query = { projectIds, start };
    const [traces, observations, scores] =
      projectIds.length === 0
        ? [0, 0, 0]
        : await Promise.all([
            getTraceCountOfProjectsSinceCreationDate(query),
            getObservationCountOfProjectsSinceCreationDate(query),
            getScoreCountOfProjectsSinceCreationDate(query),
          ]);
    const currentUnits = traces + observations + scores;

    await prisma.organization.update({
      where: { id: organization.id },
      data: {
        cloudCurrentCycleUsage: currentUnits,
        cloudBillingCycleUpdatedAt: now,
      },
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
