import { Job, Processor } from "bullmq";
import { QueueName, TQueueJobTypes } from "@langfuse/shared/src/server";

import { processDorisScoreDelete } from "../features/scores/processDorisScoreDelete";

export const scoreDeleteProcessor: Processor = async (
  job: Job<TQueueJobTypes[QueueName.ScoreDelete]>,
): Promise<void> => {
  const { scoreIds, projectId } = job.data.payload;
  await processDorisScoreDelete(projectId, scoreIds);
};
