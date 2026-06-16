import { type PgBossJobEnvelope } from "@langfuse/shared/src/server";
import { processDorisDatasetDelete } from "../features/datasets/processDorisDatasetDelete";
import type { DatasetQueueEventType } from "@langfuse/shared/src/server";

type DatasetDeletePayload = DatasetQueueEventType;

export const datasetDeleteProcessor = async (job: {
  data: PgBossJobEnvelope<DatasetDeletePayload>;
}): Promise<void> => {
  await processDorisDatasetDelete(job.data.payload);
};
