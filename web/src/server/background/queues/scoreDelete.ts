import { type PgBossJobEnvelope } from "@langfuse/shared/src/server";
import { processDorisScoreDelete } from "../features/scores/processDorisScoreDelete";

type ScoreDeletePayload = { projectId: string; scoreIds: string[] };

export const scoreDeleteProcessor = async (job: {
  data: PgBossJobEnvelope<ScoreDeletePayload>;
}): Promise<void> => {
  const { scoreIds, projectId } = job.data.payload;
  await processDorisScoreDelete(projectId, scoreIds);
};
