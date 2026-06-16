import { prisma } from "@langfuse/shared/src/db";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
  logger,
} from "@langfuse/shared/src/server";

export const handleMixpanelIntegrationSchedule = async () => {
  const mixpanelIntegrationProjects = await prisma.mixpanelIntegration.findMany(
    {
      select: {
        lastSyncAt: true,
        projectId: true,
      },
      where: {
        enabled: true,
      },
    },
  );

  if (mixpanelIntegrationProjects.length === 0) {
    logger.info("[MIXPANEL] No Mixpanel integrations ready for sync");
    return;
  }

  logger.info(
    `[MIXPANEL] Scheduling ${mixpanelIntegrationProjects.length} Mixpanel integrations for sync`,
  );

  await getPgBossQueue(QueueName.MixpanelIntegrationProcessingQueue).insertBulk(
    mixpanelIntegrationProjects.map(
      (integration: { projectId: string; lastSyncAt: Date | null }) => ({
        jobName: QueueJobs.MixpanelIntegrationProcessingJob,
        payload: {
          projectId: integration.projectId,
        },
        options: {
          singletonKey: `${integration.projectId}-${integration.lastSyncAt?.toISOString() ?? ""}`,
        },
      }),
    ),
  );
};
