import { type z } from "zod/v4";
import {
  DEFAULT_TRACE_ENVIRONMENT,
  type LLMAsJudgeExecutionEventSchema,
  dorisClient,
  logger,
  type DorisClientType,
} from "@langfuse/shared/src/server";
import {
  observationVariableMappingList,
  isJobConfigExecutable,
  type ObservationVariableMapping,
} from "@langfuse/shared";
import { prisma, JobExecutionStatus } from "@langfuse/shared/src/db";
import { UnrecoverableError } from "../../../errors/UnrecoverableError";
import { extractObservationVariables } from "./extractObservationVariables";
import { executeLLMAsJudgeEvaluation } from "../evalService";
import { fetchObservationForEval } from "./fetchObservationForEval";
import { type ObservationForEval } from "./types";

/**
 * Dependencies for processing observation evals.
 * Doris read is injectable so tests can stub it.
 */
export interface ObservationEvalProcessorDeps {
  fetchObservation: (params: {
    projectId: string;
    spanId: string;
    startTimeDate: string;
    retry?: {
      maxAttempts: number;
      initialDelayMs: number;
      backoffMultiplier: number;
      maxDelayMs?: number;
    };
  }) => Promise<ObservationForEval | null>;
}

const OBSERVATION_FETCH_RETRY = {
  maxAttempts: 7,
  initialDelayMs: 200,
  backoffMultiplier: 2,
  maxDelayMs: 5_000,
} as const;

/**
 * Production deps: read from Doris events_full. No S3 dependency.
 */
export function createObservationEvalProcessorDeps(): ObservationEvalProcessorDeps {
  let client: DorisClientType | null = null;
  return {
    fetchObservation: async (params) => {
      if (!client) client = dorisClient();
      return fetchObservationForEval(client, params);
    },
  };
}

/**
 * Processes an observation-level LLM-as-a-judge evaluation job.
 *
 * This function:
 * 1. Fetches and validates job execution, config, and template
 * 2. Re-reads the observation from Doris events_full (the
 *    scheduling step no longer pre-uploads to S3)
 * 3. Extracts variables from the observation
 * 4. Calls the shared executeLLMAsJudgeEvaluation() for LLM call and score persistence
 */
export async function processObservationEval({
  event,
  deps = createObservationEvalProcessorDeps(),
}: {
  event: z.infer<typeof LLMAsJudgeExecutionEventSchema>;
  deps?: ObservationEvalProcessorDeps;
}): Promise<void> {
  logger.debug(
    `Processing observation eval job ${event.jobExecutionId} for project ${event.projectId}`,
  );

  // Fetch job execution
  const job = await prisma.jobExecution.findFirst({
    where: {
      id: event.jobExecutionId,
      projectId: event.projectId,
    },
  });

  if (!job) {
    logger.info(
      `Job execution ${event.jobExecutionId} not found. It may have been deleted.`,
    );

    return;
  }

  // Observation eval executions may already be CANCELLED if the evaluator was
  // blocked after scheduling, or ERROR if a previous attempt already failed and
  // the processor retried the same queue job.
  if (job.status === "CANCELLED" || job.status === "ERROR") {
    logger.debug(
      `Job execution ${event.jobExecutionId} was cancelled or has an error.`,
    );

    return;
  }

  // Fetch job configuration
  const evalJobConfig = await prisma.jobConfiguration.findFirst({
    where: {
      id: job.jobConfigurationId,
      projectId: event.projectId,
    },
    include: {
      evalTemplate: true,
    },
  });

  if (!evalJobConfig || !evalJobConfig.evalTemplate) {
    throw new UnrecoverableError(
      `Job configuration or template not found for job ${job.id}`,
    );
  }

  if (!isJobConfigExecutable(evalJobConfig)) {
    logger.debug(
      `Job execution ${event.jobExecutionId} is not executable because the evaluator is blocked or inactive.`,
    );

    await prisma.jobExecution.update({
      where: {
        id: job.id,
        projectId: event.projectId,
      },
      data: {
        status: JobExecutionStatus.CANCELLED,
        endTime: new Date(),
      },
    });

    return;
  }

  // Re-read observation row from Doris. Retry long enough to absorb normal
  // visibility lag without letting permanently missing rows pin a worker for
  // minutes.
  let observationData: ObservationForEval;
  try {
    const fetched = await deps.fetchObservation({
      projectId: event.projectId,
      spanId: event.spanId,
      startTimeDate: event.startTimeDate,
      retry: OBSERVATION_FETCH_RETRY,
    });
    if (!fetched) {
      throw new UnrecoverableError(
        `Observation row not found in events_full for project=${event.projectId} span=${event.spanId} date=${event.startTimeDate}`,
      );
    }
    observationData = fetched;
  } catch (e) {
    if (e instanceof UnrecoverableError) throw e;
    // Doris network/transient failure → retryable
    throw new Error(
      `Failed to fetch observation from Doris for span ${event.spanId}: ${e}`,
    );
  }

  logger.debug(
    `Fetched observation data for job ${job.id}: span_id=${observationData.span_id}`,
  );

  // Extract variables from observation
  const parsedVariableMapping = observationVariableMappingList.parse(
    evalJobConfig.variableMapping,
  ) as ObservationVariableMapping[];

  const extractedVariables = extractObservationVariables({
    observation: observationData,
    variableMapping: parsedVariableMapping,
  });

  logger.debug(
    `Extracted ${extractedVariables.length} variables for job ${job.id}`,
  );

  // Execute the shared LLM-as-a-judge evaluation
  await executeLLMAsJudgeEvaluation({
    projectId: event.projectId,
    jobExecutionId: event.jobExecutionId,
    job,
    config: evalJobConfig,
    template: evalJobConfig.evalTemplate,
    extractedVariables,
    environment: observationData.environment ?? DEFAULT_TRACE_ENVIRONMENT,
  });
}
