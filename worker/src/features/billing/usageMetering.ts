import { parseDbOrg, Prisma } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  getObservationCountsByProjectInCreationInterval,
  getScoreCountsByProjectInCreationInterval,
  getTraceCountsByProjectInCreationInterval,
  logger,
} from "@langfuse/shared/src/server";
import type { Job } from "bullmq";
import { backOff } from "exponential-backoff";
import Stripe from "stripe";
import { env } from "../../env";
import {
  BILLING_METER_EVENT_NAME,
  CLOUD_USAGE_METERING_CRON_NAME,
  billingMeterIdentifier,
} from "./constants";

const HOUR_MS = 60 * 60 * 1000;
const INTERVAL_DELAY_MS = HOUR_MS + 5 * 60 * 1000;

export async function processCloudUsageMetering(job?: Job) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe secret key not found");
  const initialLastRun = new Date(
    Date.now() - ((Date.now() % HOUR_MS) + HOUR_MS),
  );
  const cron = await prisma.cronJobs.upsert({
    where: { name: CLOUD_USAGE_METERING_CRON_NAME },
    create: {
      name: CLOUD_USAGE_METERING_CRON_NAME,
      state: "queued",
      lastRun: initialLastRun,
    },
    update: {},
  });
  if (
    !cron.lastRun ||
    cron.lastRun.getTime() + INTERVAL_DELAY_MS > Date.now()
  ) {
    return { processedOrganizations: 0, units: 0, caughtUp: true };
  }
  const processingLeaseCutoff = new Date(Date.now() - 30 * 60 * 1000);
  if (
    cron.state === "processing" &&
    cron.jobStartedAt &&
    cron.jobStartedAt > processingLeaseCutoff
  ) {
    return { processedOrganizations: 0, units: 0, caughtUp: false };
  }
  const claimed = await prisma.cronJobs.updateMany({
    where: {
      name: CLOUD_USAGE_METERING_CRON_NAME,
      state: cron.state,
      jobStartedAt: cron.jobStartedAt,
    },
    data: { state: "processing", jobStartedAt: new Date() },
  });
  if (claimed.count !== 1)
    return { processedOrganizations: 0, units: 0, caughtUp: false };

  const start = cron.lastRun;
  const end = new Date(start.getTime() + HOUR_MS);
  try {
    const organizations = (
      await prisma.organization.findMany({
        where: {
          cloudConfig: {
            path: ["stripe", "activeSubscriptionId"],
            not: Prisma.DbNull,
          },
        },
        include: {
          projects: { select: { id: true }, where: { deletedAt: null } },
        },
      })
    )
      .map(({ projects, ...organization }) => ({
        ...parseDbOrg(organization),
        projectIds: new Set(projects.map((project) => project.id)),
      }))
      .filter(
        (org) =>
          org.cloudConfig?.stripe?.customerId &&
          org.cloudConfig?.stripe?.activeSubscriptionId &&
          org.cloudConfig?.stripe?.resolvedPlan,
      );
    const [traceCounts, observationCounts, scoreCounts] = await Promise.all([
      getTraceCountsByProjectInCreationInterval({ start, end }),
      getObservationCountsByProjectInCreationInterval({ start, end }),
      getScoreCountsByProjectInCreationInterval({ start, end }),
    ]);
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    let totalUnits = 0;

    for (let index = 0; index < organizations.length; index += 1) {
      const org = organizations[index];
      await job?.updateProgress(
        (index / Math.max(1, organizations.length)) * 100,
      );
      const count = (rows: Array<{ projectId: string; count: number }>) =>
        rows.reduce(
          (sum, row) =>
            sum + (org.projectIds.has(row.projectId) ? row.count : 0),
          0,
        );
      const units =
        count(traceCounts) + count(observationCounts) + count(scoreCounts);
      totalUnits += units;
      if (units === 0) continue;
      const customerId = org.cloudConfig!.stripe!.customerId!;
      const backup = await prisma.billingMeterBackup.upsert({
        where: {
          stripeCustomerId_meterId_startTime_endTime: {
            stripeCustomerId: customerId,
            meterId: BILLING_METER_EVENT_NAME,
            startTime: start,
            endTime: end,
          },
        },
        create: {
          stripeCustomerId: customerId,
          meterId: BILLING_METER_EVENT_NAME,
          startTime: start,
          endTime: end,
          aggregatedValue: units,
          eventName: BILLING_METER_EVENT_NAME,
          orgId: org.id,
        },
        update: {
          aggregatedValue: units,
          eventName: BILLING_METER_EVENT_NAME,
          orgId: org.id,
        },
      });
      if (backup.submittedAt) continue;
      await backOff(
        () =>
          stripe.billing.meterEvents.create({
            event_name: BILLING_METER_EVENT_NAME,
            identifier: billingMeterIdentifier(org.id, start),
            timestamp: Math.floor(end.getTime() / 1000),
            payload: {
              stripe_customer_id: customerId,
              value: units.toString(),
            },
          }),
        { numOfAttempts: 3 },
      );
      await prisma.billingMeterBackup.update({
        where: {
          stripeCustomerId_meterId_startTime_endTime: {
            stripeCustomerId: customerId,
            meterId: BILLING_METER_EVENT_NAME,
            startTime: start,
            endTime: end,
          },
        },
        data: { submittedAt: new Date() },
      });
    }

    await prisma.cronJobs.update({
      where: { name: CLOUD_USAGE_METERING_CRON_NAME },
      data: { lastRun: end, state: "queued", jobStartedAt: null },
    });
    logger.info("Cloud usage metering interval completed", {
      start,
      end,
      organizations: organizations.length,
      units: totalUnits,
    });
    return {
      processedOrganizations: organizations.length,
      units: totalUnits,
      caughtUp: end.getTime() + INTERVAL_DELAY_MS >= Date.now(),
    };
  } catch (error) {
    await prisma.cronJobs.update({
      where: { name: CLOUD_USAGE_METERING_CRON_NAME },
      data: { state: "queued", jobStartedAt: null },
    });
    throw error;
  }
}
