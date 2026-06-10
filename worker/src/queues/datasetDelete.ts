import { Job, Processor } from "bullmq";
import { QueueName, TQueueJobTypes } from "@langfuse/shared/src/server";
import { processDorisDatasetDelete } from "../features/datasets/processDorisDatasetDelete";

export const datasetDeleteProcessor: Processor = async (
  job: Job<TQueueJobTypes[QueueName.DatasetDelete]>,
): Promise<void> => {
  await processDorisDatasetDelete(job.data.payload);
};
