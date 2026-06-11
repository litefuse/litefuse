import {
  deleteScores,
  logger,
  traceException,
  deleteIngestionEventsFromS3AndDorisForScores,
} from "@langfuse/shared/src/server";
import { env } from "../../env";

export const processDorisScoreDelete = async (
  projectId: string,
  scoreIds: string[],
) => {
  const backendName = "Doris";
  logger.info(
    `Deleting scores ${JSON.stringify(scoreIds)} in project ${projectId} from ${backendName} and S3`,
  );

  try {
    await Promise.all([
      env.LITEFUSE_ENABLE_BLOB_STORAGE_FILE_LOG === "true"
        ? deleteIngestionEventsFromS3AndDorisForScores({
            projectId,
            scoreIds,
          })
        : Promise.resolve(),
      deleteScores(projectId, scoreIds),
    ]);
  } catch (e) {
    logger.error(
      `Error deleting scores ${JSON.stringify(scoreIds)} in project ${projectId} from ${backendName}`,
      e,
    );
    traceException(e);
    throw e;
  }
};
