import { prisma } from "@langfuse/shared/src/db";
import {
  QueueJobs,
  logger,
  getPgBossQueue,
  QueueName,
} from "@langfuse/shared/src/server";

export const handleBlobStorageIntegrationSchedule = async () => {
  const now = new Date();

  const blobStorageIntegrationProjects =
    await prisma.blobStorageIntegration.findMany({
      select: {
        lastSyncAt: true,
        projectId: true,
      },
      where: {
        enabled: true,
        OR: [{ lastSyncAt: null }, { nextSyncAt: { lte: now } }],
      },
    });

  if (blobStorageIntegrationProjects.length === 0) {
    logger.info("No blob storage integrations ready for sync");
    return;
  }

  logger.info(
    `Scheduling ${blobStorageIntegrationProjects.length} blob storage integrations for sync`,
  );

  const queue = getPgBossQueue(QueueName.BlobStorageIntegrationProcessingQueue);
  await queue.insertBulk(
    blobStorageIntegrationProjects.map((integration) => ({
      jobName: QueueJobs.BlobStorageIntegrationProcessingJob,
      payload: { projectId: integration.projectId },
      options: {
        singletonKey: `${integration.projectId}-${integration.lastSyncAt?.toISOString() ?? ""}`,
      },
    })),
  );
};
