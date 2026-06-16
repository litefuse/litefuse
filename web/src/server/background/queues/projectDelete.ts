import {
  deleteEventsByProjectId,
  deleteMediaFiles,
  deleteObservationsByProjectId,
  deleteScoresByProjectId,
  deleteTracesByProjectId,
  deleteDatasetRunItemsByProjectId,
  findAllMediaByProjectId,
  getCurrentSpan,
  getS3MediaStorageClient,
  logger,
  type PgBossJobEnvelope,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { Prisma } from "@prisma/client";
import { env } from "@/src/env.mjs";

type ProjectDeletePayload = { projectId: string; orgId: string };

export const projectDeleteProcessor = async (job: {
  data: PgBossJobEnvelope<ProjectDeletePayload>;
}): Promise<void> => {
  const { orgId, projectId } = job.data.payload;

  const span = getCurrentSpan();
  if (span) {
    span.setAttribute("job.input.id", job.data.id ?? "");
    span.setAttribute("job.input.projectId", job.data.payload.projectId);
    span.setAttribute("job.input.orgId", job.data.payload.orgId);
  }

  logger.info(`Deleting ${projectId} in org ${orgId}`);

  // Delete media data from S3 and PG for project
  if (env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET) {
    logger.info(`Deleting media for ${projectId} in org ${orgId}`);
    const mediaFilesToDelete = await findAllMediaByProjectId({ projectId });
    await deleteMediaFiles({
      projectId,
      mediaFiles: mediaFilesToDelete,
      storageClient: getS3MediaStorageClient(
        env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET,
      ),
    });
  }

  logger.info(`Deleting Doris and S3 data for ${projectId} in org ${orgId}`);

  // Delete project data from Doris.
  // (S3 blob cleanup removed; ingestion no longer writes to MinIO.)
  await Promise.all([
    deleteTracesByProjectId(projectId),
    deleteObservationsByProjectId(projectId),
    deleteScoresByProjectId(projectId),
    deleteEventsByProjectId(projectId),
  ]);

  // Trigger async delete of dataset run items
  await deleteDatasetRunItemsByProjectId(projectId);

  logger.info(`Deleting PG data for project ${projectId} in org ${orgId}`);

  // Finally, delete the project itself which should delete all related
  // resources due to the referential actions defined via Prisma
  try {
    const existingProject = await prisma.project.findUnique({
      where: {
        id: projectId,
        orgId,
      },
    });
    if (!existingProject) {
      logger.info(
        `Tried to delete project ${projectId} from PG, but it does not exist anymore.`,
      );
      return;
    }
    await prisma.project.delete({
      where: {
        id: projectId,
        orgId,
      },
    });
  } catch (e) {
    logger.error(`Error deleting project ${projectId} in org ${orgId}: ${e}`, {
      stack: e instanceof Error ? e.stack : undefined,
    });
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2025" || e.code === "P2016") {
        logger.warn(
          `Tried to delete project ${projectId} in org ${orgId}, but it does not exist`,
        );
        return;
      }
    }
    throw e;
  }

  logger.info(`Deleted ${projectId} in org ${orgId}`);
};
