import { enqueuePgBossJob } from "../pgboss/pgBoss";
import { QueueJobs, QueueName } from "../queues";

type DatasetDeletionType = "dataset" | "dataset-runs";

type DatasetDeletionPayload = {
  deletionType: DatasetDeletionType;
  projectId: string;
  datasetId: string;
  datasetRunIds?: string[];
};

export const addToDeleteDatasetQueue = async ({
  deletionType,
  projectId,
  datasetId,
  datasetRunIds = [],
}: DatasetDeletionPayload) => {
  await enqueuePgBossJob(QueueName.DatasetDelete, QueueJobs.DatasetDelete, {
    deletionType,
    projectId,
    datasetId,
    datasetRunIds,
  });
};
