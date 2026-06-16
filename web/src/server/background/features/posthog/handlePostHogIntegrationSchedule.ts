import { prisma } from "@langfuse/shared/src/db";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
  logger,
} from "@langfuse/shared/src/server";

export const handlePostHogIntegrationSchedule = async () => {
  const postHogIntegrationProjects = await prisma.posthogIntegration.findMany({
    select: {
      lastSyncAt: true,
      projectId: true,
    },
    where: {
      enabled: true,
    },
  });

  if (postHogIntegrationProjects.length === 0) {
    logger.info("[POSTHOG] No PostHog integrations ready for sync");
    return;
  }

  logger.info(
    `[POSTHOG] Scheduling ${postHogIntegrationProjects.length} PostHog integrations for sync`,
  );

  await getPgBossQueue(QueueName.PostHogIntegrationProcessingQueue).insertBulk(
    postHogIntegrationProjects.map((integration) => ({
      jobName: QueueJobs.PostHogIntegrationProcessingJob,
      payload: {
        projectId: integration.projectId,
      },
      options: {
        // Keep a stable singleton key per sync window to avoid duplicate
        // project syncs while the same window is still queued.
        singletonKey: `${integration.projectId}-${integration.lastSyncAt?.toISOString() ?? ""}`,
      },
    })),
  );
};
