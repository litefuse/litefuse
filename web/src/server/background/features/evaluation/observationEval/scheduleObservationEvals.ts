import {
  type ObservationForEval,
  type ObservationEvalConfig,
  type ObservationEvalSchedulerDeps,
} from "./types";
import { shouldSampleObservation } from "./shouldSampleObservation";
import { InMemoryFilterService, logger } from "@langfuse/shared/src/server";
import {
  EvalTargetObject,
  JobExecutionStatus,
  type FilterState,
  isJobConfigExecutable,
  mapEventEvalFilterColumnIdToField,
} from "@langfuse/shared";
import { createW3CTraceId } from "../../utils";

interface ScheduleObservationEvalsParams {
  observation: ObservationForEval;
  /**
   * Partition key for re-reading this row from events_full at eval
   * execution time (YYYY-MM-DD). Producers always know this because
   * they had to query Doris by partition to find the row.
   */
  startTimeDate: string;
  configs: ObservationEvalConfig[];
  schedulerDeps: ObservationEvalSchedulerDeps;
}

/**
 * Schedule observation evals for a given observation.
 *
 * This function receives pre-fetched configs (already filtered by targetObject: "event" or "experiment"
 * and project). It evaluates each config's filter and sampling against the observation,
 * checks for deduplication, and creates job executions for matching configs.
 *
 * No S3 upload happens here: the eval job just gets the Doris
 * coordinates (spanId + startTimeDate) and the processor re-reads
 * events_full at execution time.
 *
 * @param params.observation - The ObservationForEval (converted from processToEvent() or a Doris read)
 * @param params.startTimeDate - YYYY-MM-DD partition key for the Doris re-read
 * @param params.configs - Pre-fetched observation eval configs for this project
 * @param params.schedulerDeps - Dependencies for scheduling (job execution, queue)
 */
export async function scheduleObservationEvals(
  params: ScheduleObservationEvalsParams,
): Promise<void> {
  const { observation, startTimeDate, configs, schedulerDeps } = params;

  // Early return if no configs
  if (configs.length === 0) {
    return;
  }

  // Filter configs that match this observation (filter + sampling).
  const matchingConfigs = configs.filter((config) => {
    if (!isJobConfigExecutable(config)) {
      logger.debug("Skipping non-executable observation eval config", {
        configId: config.id,
      });

      return false;
    }

    // Check filter
    const isTargeted = evaluateFilter(observation, config);
    if (!isTargeted) {
      logger.debug("Observation does not match eval config filter", {
        configId: config.id,
        observationId: observation.span_id,
      });

      return false;
    }

    // Check sampling
    const samplingRate = config.sampling.toNumber();
    if (!shouldSampleObservation({ samplingRate })) {
      logger.debug("Observation sampled out for eval config", {
        configId: config.id,
        observationId: observation.span_id,
        samplingRate,
      });

      return false;
    }

    return true;
  });

  // Early return if no configs match
  if (matchingConfigs.length === 0) return;

  // Process each matching config
  await Promise.all(
    matchingConfigs.map((matchingConfig) =>
      processMatchingConfig({
        observation,
        startTimeDate,
        matchingConfig,
        schedulerDeps,
      }).catch((error) => {
        logger.error("Failed to process observation eval config", {
          configId: matchingConfig.id,
          observationId: observation.span_id,
          projectId: observation.project_id,
          error,
        });
      }),
    ),
  );
}

interface ProcessConfigParams {
  observation: ObservationForEval;
  startTimeDate: string;
  matchingConfig: ObservationEvalConfig;
  schedulerDeps: ObservationEvalSchedulerDeps;
}

async function processMatchingConfig(
  params: ProcessConfigParams,
): Promise<void> {
  const { observation, startTimeDate, matchingConfig, schedulerDeps } = params;

  const isTraceConfig = matchingConfig.targetObject === EvalTargetObject.TRACE;

  const jobExecutionId = createW3CTraceId(
    isTraceConfig
      ? `${matchingConfig.id}:${observation.trace_id}`
      : `${matchingConfig.id}:${observation.span_id}`,
  );

  // Create job execution — trace evals omit jobInputObservationId
  await schedulerDeps.upsertJobExecution({
    id: jobExecutionId,
    projectId: observation.project_id,
    jobConfigurationId: matchingConfig.id,
    jobInputTraceId: observation.trace_id,
    jobInputObservationId: isTraceConfig ? null : observation.span_id,
    jobTemplateId: matchingConfig.evalTemplateId,
    status: JobExecutionStatus.PENDING,
  });

  // Enqueue eval job — trace evals go to EvaluationExecution,
  // observation evals go to LLMAsJudgeExecution with span coordinates
  await schedulerDeps.enqueueEvalJob({
    jobExecutionId,
    projectId: observation.project_id,
    spanId: observation.span_id,
    startTimeDate,
    delay: 0,
    targetObject: matchingConfig.targetObject,
  });

  logger.debug("Scheduled observation eval job", {
    configId: matchingConfig.id,
    observationId: observation.span_id,
    jobExecutionId,
  });
}

/**
 * Evaluate filter conditions against observation.
 * Returns true if observation matches all filter conditions (or filter is empty).
 */
function evaluateFilter(
  observation: ObservationForEval,
  config: ObservationEvalConfig,
): boolean {
  const filterConditions = config.filter as FilterState;
  const isExperimentConfig =
    config.targetObject === EvalTargetObject.EXPERIMENT;
  const isExperimentRoot =
    observation.span_id === observation.experiment_item_root_span_id;

  // Empty filter matches all (for filter purposes)
  const isEmptyFilter =
    !filterConditions ||
    !Array.isArray(filterConditions) ||
    filterConditions.length === 0;

  // Map filter column IDs to observation field values for in-memory filtering
  const fieldMapper = (obs: ObservationForEval, column: string) =>
    mapEventEvalFilterColumnIdToField(obs, column);

  // Use InMemoryFilterService to evaluate filter if there are conditions
  const isFilterMatch = isEmptyFilter
    ? true
    : InMemoryFilterService.evaluateFilter(
        observation,
        filterConditions,
        fieldMapper,
      );

  // For experiment configs, must also match experiment root span.
  // For trace configs, only trigger on root span (parent_span_id is empty).
  if (isExperimentConfig) return isFilterMatch && isExperimentRoot;
  if (config.targetObject === EvalTargetObject.TRACE) {
    const isRootSpan =
      !observation.parent_span_id || observation.parent_span_id === "";
    return isFilterMatch && isRootSpan;
  }
  return isFilterMatch;
}
