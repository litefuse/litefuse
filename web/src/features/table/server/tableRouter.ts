import { generateBatchActionId } from "./helpers";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { GetIsBatchActionInProgressSchema } from "@langfuse/shared";
import { getPgBossQueue, QueueName } from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";

const WAITING_JOB_STATES = ["created", "retry", "active"] as const;
const WAITING_JOB_STATE_SET = new Set<string>(WAITING_JOB_STATES);

export const tableRouter = createTRPCRouter({
  getIsBatchActionInProgress: protectedProjectProcedure
    .input(GetIsBatchActionInProgressSchema)
    .query(async ({ input }) => {
      const { projectId, tableName, actionId } = input;
      const batchActionId = generateBatchActionId(
        projectId,
        actionId,
        tableName,
      );

      const batchActionJobs = await getPgBossQueue(
        QueueName.BatchActionQueue,
      ).findJobs({ key: batchActionId });
      const isInProgress = batchActionJobs.some((job) =>
        WAITING_JOB_STATE_SET.has(job.state),
      );

      return isInProgress;
    }),
});
