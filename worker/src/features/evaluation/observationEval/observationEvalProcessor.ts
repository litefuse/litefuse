import { z } from "zod/v4";
import {
  DEFAULT_TRACE_ENVIRONMENT,
  LLMAsJudgeExecutionEventSchema,
  logger,
} from "@langfuse/shared/src/server";
import {
  observationForEvalSchema,
  observationVariableMappingList,
  isJobConfigExecutable,
  EvalTemplateType,
  type ObservationVariableMapping,
} from "@langfuse/shared";
import { prisma, JobExecutionStatus } from "@langfuse/shared/src/db";
import { UnrecoverableError } from "../../../errors/UnrecoverableError";
import { extractObservationVariables } from "./extractObservationVariables";
import { executeLLMAsJudgeEvaluation } from "../evalService";
import { getEvalS3StorageClient } from "../s3StorageClient";
import { type ObservationForEval } from "./types";
import {
  createProductionEvalExecutionDeps,
  type EvalExecutionDeps,
} from "../evalExecutionDeps";
import { runV2LlmEvaluatorEvaluation } from "../v2LlmEvaluatorExecution";
import { runV2DecisionModelEvaluation } from "../v2DecisionModelExecution";
import { resolveV2Execution } from "../v2ExecutionResolution";
import { isEvalTargetEnvironmentAllowed } from "../isEvalTargetEnvironmentAllowed";

/**
 * Dependencies for processing observation evals.
 * Allows S3 operations to be injected for testability.
 */
export interface ObservationEvalProcessorDeps {
  downloadObservationFromS3: (path: string) => Promise<string>;
  /**
   * LITEFUSE ADDITION (evaluators v2): the v2 executors persist scores through
   * these deps, exactly like the trace/dataset path.
   */
  evalExecutionDeps: EvalExecutionDeps;
}

/**
 * Creates production dependencies for the observation eval processor.
 */
export function createObservationEvalProcessorDeps(): ObservationEvalProcessorDeps {
  return {
    downloadObservationFromS3: async (path: string) => {
      const s3Client = getEvalS3StorageClient();

      return s3Client.download(path);
    },
    evalExecutionDeps: createProductionEvalExecutionDeps(),
  };
}

/**
 * Processes an observation-level evaluation job.
 *
 * This function:
 * 1. Fetches job execution, config, and template
 * 2. Downloads observation data from S3 (stored during scheduling)
 * 3. Extracts variables from the observation
 * 4. Calls the shared executeLLMAsJudgeEvaluation() for LLM call and score persistence
 *
 * ── LITEFUSE ADDITION (evaluators v2) ───────────────────────────────────────
 * A job whose `jobConfigurationId` is an `evaluation_rules` id has no
 * `job_configurations` row. Those jobs resolve through the evaluator tables
 * (`resolveV2Execution`) and run on the v2-native executors, which support all
 * three score data types and decision-model evaluators. The legacy branch below
 * is unchanged.
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

  const isLegacyExecution = Boolean(evalJobConfig?.evalTemplate);

  // ── Evaluators v2: resolve the evaluator behind the job ───────────────────
  const v2Execution = isLegacyExecution
    ? null
    : await resolveV2Execution({
        projectId: event.projectId,
        jobConfigurationId: job.jobConfigurationId,
        identity: {
          evaluatorId: event.evaluatorId,
          evaluationRuleId: event.evaluationRuleId,
        },
        evaluatorTypes: [
          EvalTemplateType.LLM_AS_JUDGE,
          EvalTemplateType.DECISION_MODEL,
        ],
        // A manual batch run addresses the evaluator directly and is authorized
        // by the user's selection rather than by the rule's status.
        allowRulelessEvaluator: true,
        allowInactiveRule: event.executionMode === "MANUAL",
        mappingOverride: event.variableMapping,
      });

  if (!isLegacyExecution && v2Execution?.type === "cancelled") {
    logger.info(
      `Cancelling observation eval job ${job.id}: ${v2Execution.reason}`,
    );

    await cancelJobExecution(job.id, event.projectId);

    return;
  }

  if (
    isLegacyExecution &&
    (!evalJobConfig || !isJobConfigExecutable(evalJobConfig))
  ) {
    logger.debug(
      `Job execution ${event.jobExecutionId} is not executable because the evaluator is blocked or inactive.`,
    );

    await cancelJobExecution(job.id, event.projectId);

    return;
  }

  // Download observation data from S3
  let observationData: ObservationForEval;
  let downloadedString: string;

  try {
    downloadedString = await deps.downloadObservationFromS3(
      event.observationS3Path,
    );
  } catch (e) {
    // S3 download failures are retryable (network issues, temporary unavailability)
    throw new Error(
      `Failed to download observation from S3 at ${event.observationS3Path}: ${e}`,
    );
  }

  // Parse and validate the downloaded data - these are permanent failures
  try {
    const parsedJson = JSON.parse(downloadedString);
    observationData = observationForEvalSchema.parse(parsedJson);
  } catch (e) {
    // JSON parse errors are permanent - the data won't change on retry
    throw new UnrecoverableError(
      `Invalid observation data from S3 at ${event.observationS3Path}: invalid JSON - ${e}`,
    );
  }

  logger.debug(
    `Downloaded observation data for job ${job.id}: span_id=${observationData.span_id}`,
  );

  // Final fail-closed loop safeguard: never execute an eval whose target lives in
  // an internal Langfuse environment, regardless of which scheduling path created
  // the job. See isEvalTargetEnvironmentAllowed.
  if (!isEvalTargetEnvironmentAllowed(observationData.environment)) {
    logger.warn(
      "Cancelling eval job targeting an internal Langfuse environment",
      {
        jobExecutionId: event.jobExecutionId,
        projectId: event.projectId,
        environment: observationData.environment,
        observationId: observationData.span_id,
      },
    );

    await cancelJobExecution(job.id, event.projectId);

    return;
  }

  const environment = observationData.environment ?? DEFAULT_TRACE_ENVIRONMENT;

  if (isLegacyExecution && evalJobConfig?.evalTemplate) {
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
      environment,
    });
    return;
  }

  if (v2Execution?.type !== "v2") {
    // Unreachable: the cancelled branch above returned, and a legacy execution
    // returned as well.
    throw new UnrecoverableError(
      `Unable to resolve an execution for observation eval job ${job.id}`,
    );
  }

  const parsedVariableMapping = observationVariableMappingList.parse(
    v2Execution.variableMapping,
  ) as ObservationVariableMapping[];

  const extractedVariables = extractObservationVariables({
    observation: observationData,
    variableMapping: parsedVariableMapping,
  });

  logger.debug(
    `Extracted ${extractedVariables.length} variables for evaluator v2 job ${job.id}`,
  );

  if (v2Execution.evaluatorType === "DECISION_MODEL") {
    await runV2DecisionModelEvaluation({
      projectId: event.projectId,
      jobExecutionId: event.jobExecutionId,
      job,
      evaluatorId: v2Execution.evaluatorId,
      evaluationRuleId: v2Execution.evaluationRuleId,
      assignmentId: v2Execution.assignmentId,
      scoreName: v2Execution.scoreName,
      version: v2Execution.version,
      extractedVariables,
      environment,
      deps: deps.evalExecutionDeps,
    });

    return;
  }

  await runV2LlmEvaluatorEvaluation({
    projectId: event.projectId,
    jobExecutionId: event.jobExecutionId,
    job,
    evaluatorId: v2Execution.evaluatorId,
    evaluationRuleId: v2Execution.evaluationRuleId,
    assignmentId: v2Execution.assignmentId,
    scoreName: v2Execution.scoreName,
    version: v2Execution.version,
    variableMapping: v2Execution.variableMapping,
    extractedVariables,
    environment,
    deps: deps.evalExecutionDeps,
  });
}

async function cancelJobExecution(jobId: string, projectId: string) {
  await prisma.jobExecution.update({
    where: {
      id: jobId,
      projectId,
    },
    data: {
      status: JobExecutionStatus.CANCELLED,
      endTime: new Date(),
    },
  });
}
