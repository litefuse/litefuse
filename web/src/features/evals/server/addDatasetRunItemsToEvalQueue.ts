import { randomUUID } from "crypto";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
} from "@langfuse/shared/src/server";

export const addDatasetRunItemsToEvalQueue = async ({
  projectId,
  datasetItemId,
  datasetItemValidFrom,
  traceId,
  observationId,
}: {
  projectId: string;
  datasetItemId: string;
  datasetItemValidFrom: Date;
  traceId: string;
  observationId?: string;
}) => {
  await getPgBossQueue(QueueName.DatasetRunItemUpsert).send(
    QueueJobs.DatasetRunItemUpsert,
    {
      projectId,
      datasetItemId,
      datasetItemValidFrom,
      traceId,
      observationId: observationId ?? undefined,
    },
    { id: randomUUID() },
  );
};
