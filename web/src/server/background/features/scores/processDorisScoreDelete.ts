import {
  deleteScores,
  logger,
  traceException,
} from "@langfuse/shared/src/server";

export const processDorisScoreDelete = async (
  projectId: string,
  scoreIds: string[],
) => {
  const backendName = "Doris";
  logger.info(
    `Deleting scores ${JSON.stringify(scoreIds)} in project ${projectId} from ${backendName}`,
  );

  // S3 score blob cleanup removed: scores are direct-written through
  // processEventBatch and no longer have a separate MinIO staging file.
  try {
    await deleteScores(projectId, scoreIds);
  } catch (e) {
    logger.error(
      `Error deleting scores ${JSON.stringify(scoreIds)} in project ${projectId} from ${backendName}`,
      e,
    );
    traceException(e);
    throw e;
  }
};
