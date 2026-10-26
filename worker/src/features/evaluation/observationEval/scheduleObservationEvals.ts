import {
  type ObservationForEval,
  type ObservationEvalRule,
  type EvaluationRuleWithAssignments,
  type ObservationEvalSchedulerDeps,
} from "./types";
import {
  getDeterministicSamplingValue,
  shouldSampleEvaluation,
} from "../deterministicSampling";import { InMemoryFilterService, logger } from "@langfuse/shared/src/server";
import {
  EvalTargetObject,
  JobExecutionStatus,
  type EvalTemplateType,
  type FilterState,
  type EvalExecutionMode,
  type ObservationVariableMapping,
  isJobConfigExecutable,
  mapEventEvalFilterColumnIdToField,
} from "@langfuse/shared";
import { createW3CTraceId } from "../../utils";
import { isInternalEvalEnvironment } from "../isEvalTargetEnvironmentAllowed";

/**
 * ── LITEFUSE ADDITION (copied from upstream) ────────────────────────────────
 * Loop safeguard at scheduling time: internal Langfuse executions write their
 * telemetry into reserved `langfuse-*` environments, and evaluating that
 * telemetry would spawn another internal execution whose telemetry could be
 * evaluated again.
 *
 * Prompt experiments are the sanctioned exception, but only for their ROOT span:
 * a user attaches evaluators to a dataset run, and without the root-span check
 * every span of the run would be evaluated (the run's spans are copies of the
 * user's spans, so evaluating each of them is both duplicated cost and a
 * different result set than the user asked for).
 *
 * The executors repeat this check before spending money on an LLM call.
 */
export function isObservationAllowedForQueuedObservationEvals(
  observation: Pick<
    ObservationForEval,
    "environment" | "span_id" | "experiment_item_root_span_id"
  >,
): boolean {
  if (!isInternalEvalEnvironment(observation.environment)) {
    return true;
  }

  return (
    observation.environment === "langfuse-prompt-experiment" &&
    observation.experiment_item_root_span_id != null &&
    observation.span_id === observation.experiment_item_root_span_id
  );
}

interface ScheduleObservationEvalsParams {
  observation: ObservationForEval;
  configs: ObservationEvalRule[];
  schedulerDeps: ObservationEvalSchedulerDeps;
  /**
   * LITEFUSE ADDITION (copied from upstream): set to "MANUAL" for one-shot batch
   * runs. A manual run is authorized by the user's own selection, so the executor
   * must not cancel it merely because the rule was deactivated in the meantime.
   */
  executionMode?: EvalExecutionMode;
}

/**
 * Schedule observation evals for a given observation.
 *
 * This function receives pre-fetched rules (already filtered by targetObject:
 * "event" or "experiment" and project). It evaluates each rule's filter and
 * sampling against the observation, checks for deduplication, and creates job
 * executions for matching rules.
 *
 * ── LITEFUSE ADDITION (evaluators v2) ───────────────────────────────────────
 * A v2 evaluation rule may assign several evaluators, and each assignment is its
 * own execution (own job execution row, own score, own dedup key). Legacy job
 * configurations keep their previous single-execution behaviour and job-id
 * derivation, so in-flight legacy jobs are not duplicated.
 *
 * The observation is uploaded to S3 once (not per rule) for efficiency.
 *
 * @param params.observation - The ObservationForEval (converted from processToEvent() or ClickHouse)
 * @param params.configs - Pre-fetched observation eval rules for this project
 * @param params.schedulerDeps - Dependencies for scheduling (S3, job execution, queue)
 */
export async function scheduleObservationEvals(
  params: ScheduleObservationEvalsParams,
): Promise<void> {
  const { observation, configs, schedulerDeps, executionMode } = params;

  // Early return if no configs
  if (configs.length === 0) {
    return;
  }

  // Loop safeguard: never schedule an eval whose target is internal Langfuse
  // telemetry (see isObservationAllowedForQueuedObservationEvals).
  if (!isObservationAllowedForQueuedObservationEvals(observation)) {
    logger.debug("Skipping observation eval scheduling for internal environment", {
      observationId: observation.span_id,
      environment: observation.environment,
    });

    return;
  }

  // Deterministic per-observation sampling value: the same span always lands on
  // the same side of the threshold, so a retried scheduling attempt cannot
  // produce a different set of evaluations.
  const samplingValue = getDeterministicSamplingValue(observation.span_id);

  // Filter configs that match this observation (filter + sampling).
  // This is done before S3 upload to avoid unnecessary uploads.
  const matchingConfigs = configs.filter((config) => {
    if (!isExecutableRule(config)) {
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

    // Check sampling (deterministic per observation, see above)
    const samplingRate = config.sampling.toNumber();
    if (!shouldSampleEvaluation({ samplingValue, samplingRate })) {
      logger.debug("Observation sampled out for eval config", {
        configId: config.id,
        observationId: observation.span_id,
        samplingRate,
      });

      return false;
    }

    return true;
  });

  // Early return if no configs match - no S3 upload needed
  if (matchingConfigs.length === 0) return;

  // Upload observation to S3 once
  const observationS3Path = await schedulerDeps.uploadObservationToS3({
    projectId: observation.project_id,
    observationId: observation.span_id,
    data: observation,
  });

  // Process each matching config (a v2 rule contributes one job per assignment)
  await Promise.all(
    matchingConfigs.flatMap((matchingConfig) =>
      getExecutableAssignments(matchingConfig).map((assignment) =>
        processMatchingConfig({
          observation,
          matchingConfig,
          assignment,
          observationS3Path,
          schedulerDeps,
          executionMode,
        }).catch((error) => {
          logger.error("Failed to process observation eval config", {
            configId: matchingConfig.id,
            observationId: observation.span_id,
            projectId: observation.project_id,
            error,
          });
        }),
      ),
    ),
  );
}

/**
 * A rule is executable when it is active and has at least one usable assignment.
 * Legacy configs carry their blocked/inactive state on the row itself.
 */
function isExecutableRule(rule: ObservationEvalRule): boolean {
  if (isRuleWithAssignments(rule)) {
    return rule.status === "ACTIVE" && rule.assignments.length > 0;
  }

  return isJobConfigExecutable(rule);
}

function isRuleWithAssignments(
  rule: ObservationEvalRule,
): rule is EvaluationRuleWithAssignments {
  return "assignments" in rule;
}

/**
 * The (rule, evaluator) pairings to schedule. A legacy config is one execution;
 * a v2 rule contributes one per assignment, each with its own evaluator.
 */
function getExecutableAssignments(rule: ObservationEvalRule) {
  if (!isRuleWithAssignments(rule)) {
    return [
      {
        id: rule.id,
        evaluationRuleId: null as string | null,
        evaluatorId: null as string | null,
        evalTemplateId: rule.evalTemplateId,
        evalTemplateType: undefined as EvalTemplateType | undefined,
        variableMapping: undefined as ObservationVariableMapping[] | undefined,
      },
    ];
  }

  return rule.assignments.map((assignment) => ({
    id: assignment.id,
    evaluationRuleId: rule.ruleId,
    evaluatorId: assignment.evaluatorId,
    // A v2 job resolves its definition at pickup; nothing is pinned here.
    evalTemplateId: null as string | null,
    evalTemplateType: assignment.evaluator.type as EvalTemplateType,
    variableMapping:
      (assignment.variableMapping as ObservationVariableMapping[] | null) ??
      undefined,
  }));
}

type ScheduledAssignment = ReturnType<typeof getExecutableAssignments>[number];

interface ProcessConfigParams {
  observation: ObservationForEval;
  matchingConfig: ObservationEvalRule;
  assignment: ScheduledAssignment;
  observationS3Path: string;
  schedulerDeps: ObservationEvalSchedulerDeps;
  executionMode?: EvalExecutionMode;
}

async function processMatchingConfig(
  params: ProcessConfigParams,
): Promise<void> {
  const {
    observation,
    matchingConfig,
    assignment,
    observationS3Path,
    schedulerDeps,
    executionMode,
  } = params;

  // One execution per (rule, assignment, observation). The v2 form includes the
  // assignment id so a rule with two evaluators yields two distinct jobs; the
  // legacy form keeps its historical key so in-flight jobs are not duplicated.
  const jobExecutionId = isRuleWithAssignments(matchingConfig)
    ? createW3CTraceId(
        JSON.stringify([
          "observation-eval",
          matchingConfig.id,
          assignment.id,
          observation.trace_id,
          observation.span_id,
        ]),
      )
    : createW3CTraceId(`${matchingConfig.id}:${observation.span_id}`);

  // Create job execution
  await schedulerDeps.upsertJobExecution({
    id: jobExecutionId,
    projectId: observation.project_id,
    jobConfigurationId: matchingConfig.id,
    jobInputTraceId: observation.trace_id,
    jobInputObservationId: observation.span_id,
    jobTemplateId: assignment.evalTemplateId,
    status: JobExecutionStatus.PENDING,
  });

  // Enqueue eval job
  await schedulerDeps.enqueueEvalJob({
    jobExecutionId,
    projectId: observation.project_id,
    observationS3Path,
    delay: 0,
    ...(executionMode ? { executionMode } : {}),
    ...(assignment.evalTemplateType
      ? { evalTemplateType: assignment.evalTemplateType }
      : {}),
    ...(assignment.evaluatorId
      ? {
          evaluatorId: assignment.evaluatorId,
          ...(assignment.evaluationRuleId
            ? { evaluationRuleId: assignment.evaluationRuleId }
            : {}),
        }
      : {}),
    ...(assignment.variableMapping
      ? { variableMapping: assignment.variableMapping }
      : {}),
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
  config: ObservationEvalRule,
): boolean {
  const filterConditions = config.filter as FilterState;

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

  // A v2 rule arrives canonicalized (`normalizeEvaluationRuleTarget` turned the
  // legacy experiment target into its root-span filter), so only legacy configs
  // still need the extra root-span check.
  if (isRuleWithAssignments(config)) {
    return isFilterMatch;
  }

  const isExperimentConfig =
    config.targetObject === EvalTargetObject.EXPERIMENT;
  const isExperimentRoot =
    observation.span_id === observation.experiment_item_root_span_id;

  // For experiment configs, must also match experiment root span
  return isExperimentConfig ? isFilterMatch && isExperimentRoot : isFilterMatch;
}
