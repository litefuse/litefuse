import {
  getBlobStorageByProjectId,
  getBlobStorageByProjectIdAndEntityIds,
  getBlobStorageByProjectIdAndTraceIds,
  getBlobStorageByProjectIdBeforeDate,
} from "../repositories/blobStorageLog";
import { BlobStorageFileRefRecordReadType } from "../repositories/definitions";
import { logger } from "../logger";
import { env } from "../../env";
import { getS3EventStorageClient } from "../s3";
import { convertDateToAnalyticsDateTime } from "../repositories/analytics";
import { dorisClient } from "../doris/client";

export const deleteIngestionEventsFromS3AndDorisForScores = async (p: {
  projectId: string;
  scoreIds: string[];
}) => {
  const stream = getBlobStorageByProjectIdAndEntityIds(
    p.projectId,
    "score",
    p.scoreIds,
  );

  return removeIngestionEventsFromS3AndDeleteDorisRefs({
    projectId: p.projectId,
    stream,
  });
};

export const removeIngestionEventsFromS3AndDeleteDorisRefsForTraces =
  async (p: { projectId: string; traceIds: string[] }) => {
    const stream = getBlobStorageByProjectIdAndTraceIds(
      p.projectId,
      p.traceIds,
    );

    return removeIngestionEventsFromS3AndDeleteDorisRefs({
      projectId: p.projectId,
      stream: stream,
    });
  };

export const removeIngestionEventsFromS3AndDeleteDorisRefsForProject = (
  projectId: string,
  cutOffDate: Date | undefined,
) => {
  const stream = cutOffDate
    ? getBlobStorageByProjectIdBeforeDate(projectId, cutOffDate)
    : getBlobStorageByProjectId(projectId);

  return removeIngestionEventsFromS3AndDeleteDorisRefs({
    projectId: projectId,
    stream: stream,
  });
};

async function removeIngestionEventsFromS3AndDeleteDorisRefs(p: {
  projectId: string;
  stream: AsyncGenerator<BlobStorageFileRefRecordReadType>;
}) {
  const { projectId, stream } = p;

  let batch = 0;

  let blobStorageRefs: BlobStorageFileRefRecordReadType[] = [];
  const eventStorageClient = getS3EventStorageClient(
    env.LITEFUSE_S3_EVENT_UPLOAD_BUCKET!,
  );
  for await (const eventLog of stream) {
    blobStorageRefs.push(eventLog);
    if (blobStorageRefs.length > 500) {
      // Delete the current batch and reset the list
      await eventStorageClient.deleteFiles(
        blobStorageRefs.map((r) => r.bucket_path),
      );
      logger.info("deleted s3 file");
      // soft delete the blob storage references in Doris
      await softDeleteInDoris(blobStorageRefs);
      batch++;
      logger.info(
        `Deleted batch ${batch} of size ${blobStorageRefs.length} for ${projectId} of deleting s3 refs`,
      );
      blobStorageRefs = [];
    }
  }
  // Delete any remaining files
  await eventStorageClient.deleteFiles(
    blobStorageRefs.map((r) => r.bucket_path),
  );
  await softDeleteInDoris(blobStorageRefs);
  logger.info(
    `Deleted last batch ${batch} of size ${blobStorageRefs.length} for ${projectId} of deleting s3 refs`,
  );
}

async function softDeleteInDoris(
  blobStorageRefs: BlobStorageFileRefRecordReadType[],
) {
  // Doris implementation using Stream Load
  const records = blobStorageRefs.map((e) => ({
    ...e,
    is_deleted: "1",
    event_ts: convertDateToAnalyticsDateTime(new Date()),
    updated_at: convertDateToAnalyticsDateTime(new Date()),
  }));

  await dorisClient().streamLoad("blob_storage_file_log", records);
  return;
}
