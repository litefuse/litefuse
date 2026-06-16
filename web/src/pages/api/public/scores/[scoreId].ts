import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import {
  DeleteScoreQueryV1,
  DeleteScoreResponseV1,
  GetScoreQueryV1,
  GetScoreResponseV1,
  InternalServerError,
  LangfuseNotFoundError,
} from "@langfuse/shared";
import {
  logger,
  traceException,
  enqueuePgBossJob,
  QueueJobs,
  QueueName,
} from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { ScoresApiService } from "@/src/features/public-api/server/scores-api-service";

export default withMiddlewares({
  GET: createAuthedProjectAPIRoute({
    name: "Get Score",
    querySchema: GetScoreQueryV1,
    responseSchema: GetScoreResponseV1,
    fn: async ({ query, auth }) => {
      const scoresApiService = new ScoresApiService("v1");
      const score = await scoresApiService.getScoreById({
        projectId: auth.scope.projectId,
        scoreId: query.scoreId,
      });

      if (!score) {
        throw new LangfuseNotFoundError("Score not found");
      }

      const parsedScore = GetScoreResponseV1.safeParse(score);

      if (!parsedScore.success) {
        traceException(parsedScore.error);
        logger.error(`Incorrect score return type ${parsedScore.error}`);
        throw new InternalServerError("Requested score is corrupted");
      }

      return parsedScore.data;
    },
  }),
  DELETE: createAuthedProjectAPIRoute({
    name: "Delete Score",
    querySchema: DeleteScoreQueryV1,
    responseSchema: DeleteScoreResponseV1,
    successStatusCode: 202,
    fn: async ({ query, auth }) => {
      const { scoreId } = query;

      await auditLog({
        action: "delete",
        resourceType: "score",
        resourceId: scoreId,
        projectId: auth.scope.projectId,
        orgId: auth.scope.orgId,
        apiKeyId: auth.scope.apiKeyId,
      });

      await enqueuePgBossJob(QueueName.ScoreDelete, QueueJobs.ScoreDelete, {
        projectId: auth.scope.projectId,
        scoreIds: [scoreId],
      });

      return { message: "Score deletion queued successfully" };
    },
  }),
});
