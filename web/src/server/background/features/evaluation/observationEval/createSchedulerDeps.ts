import { prisma } from "@langfuse/shared/src/db";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
} from "@langfuse/shared/src/server";
import { type ObservationEvalSchedulerDeps } from "./types";

/**
 * Production dependencies for the observation eval scheduler.
 *
 * No S3 client: the eval job carries Doris coordinates (spanId +
 * startTimeDate) instead of an S3 path. The eval processor reads the
 * row out of events_full at execution time. This is how we avoid
 * a MinIO/S3 dependency for the eval pipeline.
 */
export function createObservationEvalSchedulerDeps(): ObservationEvalSchedulerDeps {
  return {
    upsertJobExecution: async (params) => {
      const {
        id,
        projectId,
        jobConfigurationId,
        jobInputTraceId,
        jobInputObservationId,
        jobTemplateId,
        status,
      } = params;

      const jobExecution = await prisma.jobExecution.upsert({
        where: {
          id,
          projectId,
        },
        create: {
          id,
          projectId,
          jobConfigurationId,
          jobInputTraceId,
          jobInputObservationId,
          jobTemplateId,
          status,
        },
        update: {
          status,
        },
      });

      return { id: jobExecution.id };
    },

    enqueueEvalJob: async (params) => {
      const isTraceEval = params.targetObject === "trace";
      const queue = getPgBossQueue(
        isTraceEval
          ? QueueName.EvaluationExecution
          : QueueName.LLMAsJudgeExecution,
      );
      const jobName = isTraceEval
        ? QueueJobs.EvaluationExecution
        : QueueJobs.LLMAsJudgeExecution;
      await queue.send(
        jobName,
        {
          projectId: params.projectId,
          jobExecutionId: params.jobExecutionId,
          ...(isTraceEval
            ? {}
            : {
                spanId: params.spanId,
                startTimeDate: params.startTimeDate,
              }),
        },
        {
          startAfter: params.delay ? params.delay / 1000 : undefined,
          retryBaggage: { originalJobTimestamp: new Date(), attempt: 0 },
        },
      );
    },
  };
}
