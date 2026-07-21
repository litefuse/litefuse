import { parseDbOrg, Role } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  getBillingCycleEnd,
  getBillingCycleStart,
  getBillingUnitCountsByProjectAndDay,
  invalidateCachedOrgApiKeys,
  logger,
  sendUsageThresholdEmail,
  traceException,
} from "@langfuse/shared/src/server";
import { env } from "../../env";
import { nextUsageState, type UsageState } from "./constants";

function isPaidOrganization(org: ReturnType<typeof parseDbOrg>) {
  return Boolean(
    (org.cloudConfig?.plan && org.cloudConfig.plan !== "Hobby") ||
      (org.cloudConfig?.stripe?.activeSubscriptionId &&
        org.cloudConfig?.stripe?.resolvedPlan),
  );
}

async function notifyUsageState(params: {
  orgId: string;
  orgName: string;
  currentUsage: number;
  state: Exclude<UsageState, null>;
  resetDate: Date;
}) {
  const members = await prisma.organizationMembership.findMany({
    where: { orgId: params.orgId, role: { in: [Role.OWNER, Role.ADMIN] } },
    select: { user: { select: { email: true } } },
  });
  const emails = [
    ...new Set(
      members
        .map((member) => member.user.email)
        .filter((email): email is string => Boolean(email)),
    ),
  ];
  const results = await Promise.allSettled(
    emails.map((receiverEmail) =>
      sendUsageThresholdEmail({
        env,
        receiverEmail,
        organizationName: params.orgName,
        orgId: params.orgId,
        currentUsage: params.currentUsage,
        blocked: params.state === "BLOCKED",
        resetDate: params.resetDate,
      }),
    ),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      traceException(result.reason);
      logger.error("Failed to send Developer usage threshold email", {
        orgId: params.orgId,
        error: result.reason,
      });
    }
  }
}

export async function processUsageThresholds(referenceDate = new Date()) {
  const organizations = (
    await prisma.organization.findMany({
      include: {
        projects: { select: { id: true }, where: { deletedAt: null } },
      },
    })
  ).map(({ projects, ...organization }) => ({
    ...parseDbOrg(organization),
    projectIds: projects.map((project) => project.id),
  }));
  if (organizations.length === 0) return { processed: 0, blocked: 0 };

  const starts = organizations.map((org) =>
    getBillingCycleStart(org, referenceDate),
  );
  const earliestStart = new Date(
    Math.min(...starts.map((date) => date.getTime())),
  );
  const rows = await getBillingUnitCountsByProjectAndDay({
    start: earliestStart,
    end: new Date(referenceDate.getTime() + 1),
  });
  const projectToOrg = new Map<string, string>();
  for (const org of organizations) {
    for (const projectId of org.projectIds) projectToOrg.set(projectId, org.id);
  }
  const cycleStartByOrg = new Map(
    organizations.map((org) => [
      org.id,
      getBillingCycleStart(org, referenceDate).toISOString().slice(0, 10),
    ]),
  );
  const usageByOrg = new Map(organizations.map((org) => [org.id, 0]));
  for (const row of rows) {
    const orgId = projectToOrg.get(row.projectId);
    if (!orgId || row.date < (cycleStartByOrg.get(orgId) ?? "")) continue;
    usageByOrg.set(orgId, (usageByOrg.get(orgId) ?? 0) + row.total);
  }

  let blocked = 0;
  for (const org of organizations) {
    const usage = usageByOrg.get(org.id) ?? 0;
    const paid = isPaidOrganization(org);
    const enforcementEnabled =
      env.LITEFUSE_FREE_TIER_USAGE_THRESHOLD_ENFORCEMENT_ENABLED === "true";
    const state = paid || !enforcementEnabled ? null : nextUsageState(usage);
    const previousState = org.cloudFreeTierUsageThresholdState as UsageState;

    await prisma.organization.update({
      where: { id: org.id },
      data: {
        cloudCurrentCycleUsage: usage,
        cloudBillingCycleUpdatedAt: referenceDate,
        cloudFreeTierUsageThresholdState: state,
      },
    });

    if (
      previousState !== state &&
      (previousState === "BLOCKED" || state === "BLOCKED")
    ) {
      await invalidateCachedOrgApiKeys(org.id);
    }
    if (!paid && state && state !== previousState) {
      await notifyUsageState({
        orgId: org.id,
        orgName: org.name,
        currentUsage: usage,
        state,
        resetDate: getBillingCycleEnd(org, referenceDate),
      });
    }
    if (state === "BLOCKED") blocked += 1;
  }

  logger.info("Developer usage threshold processing completed", {
    processed: organizations.length,
    blocked,
  });
  return { processed: organizations.length, blocked };
}

export { isPaidOrganization };
