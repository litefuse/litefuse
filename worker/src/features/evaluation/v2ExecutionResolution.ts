// ── LITEFUSE ADDITION (evaluators v2 execution resolution) ──────────────────
// One resolver shared by every execution path (trace/dataset in `evalService.ts`,
// observation/event in `observationEval/observationEvalProcessor.ts`).
//
// A v2 job names a RULE, an EVALUATOR, or both. This module turns that identity
// back into the evaluator + current version + variable mapping the v2 executors
// need, and cancels the execution when the rows no longer authorize it.
//
// Upstream keeps one resolver per queue (`resolveTraceExecution`,
// `resolveObservationEvalExecution`, plus `buildV2Execution`); the shape below is
// their union, with the differences between queues expressed as parameters:
//   * `evaluatorTypes`   — which evaluator families this queue may run,
//   * `allowRulelessEvaluator` — manual batch runs address an evaluator directly,
//   * `allowInactiveRule` — manual runs are authorized by the user's selection,
//   * `mappingOverride`  — manual runs may carry their own mapping.
// ─────────────────────────────────────────────────────────────────────────────

import { EvalTemplateType, JobConfigState, Prisma } from "@prisma/client";
import { prisma } from "@langfuse/shared/src/db";

/** The evaluator version fields the v2 executors read. */
export type V2ResolvedVersion = {
  id: string;
  version: number;
  prompt: string | null;
  promptMessages: unknown;
  vars: string[];
  provider: string | null;
  model: string | null;
  modelParams: unknown;
  outputDefinition: unknown;
  questions: unknown;
};

export type V2ResolvedExecution = {
  type: "v2";
  evaluatorType: "LLM_AS_JUDGE" | "DECISION_MODEL";
  /** Null for a ruleless manual run. */
  evaluationRuleId: string | null;
  /** Null for a ruleless manual run. */
  assignmentId: string | null;
  evaluatorId: string;
  scoreName: string;
  variableMapping: unknown;
  version: V2ResolvedVersion;
};

export type V2ResolutionResult =
  | V2ResolvedExecution
  | { type: "cancelled"; reason: string };

const evaluatorInclude = {
  versions: { orderBy: { version: "desc" as const }, take: 1 },
} satisfies Prisma.EvaluatorInclude;

/**
 * `outputDefinition.dataType` values our LLM judge can score. A judge whose
 * definition is missing or of an unknown type is not executable; decision models
 * carry questions instead and are checked by their own executor.
 */
const SUPPORTED_LLM_OUTPUT_DATA_TYPES = new Set([
  "NUMERIC",
  "BOOLEAN",
  "CATEGORICAL",
]);

function readOutputDefinitionDataType(outputDefinition: unknown): string | null {
  if (!outputDefinition || typeof outputDefinition !== "object") return null;
  const dataType = (outputDefinition as { dataType?: unknown }).dataType;
  return typeof dataType === "string" ? dataType : null;
}

function buildExecution(params: {
  rule: { id: string; status: JobConfigState } | null;
  assignment: { id: string; variableMapping: unknown } | null;
  evaluator: Prisma.EvaluatorGetPayload<{ include: typeof evaluatorInclude }>;
  mappingOverride?: unknown;
}): V2ResolutionResult {
  const { rule, assignment, evaluator } = params;

  if (rule && rule.status !== JobConfigState.ACTIVE) {
    return { type: "cancelled", reason: "rule-not-active" };
  }
  if (evaluator.blockedAt) {
    return { type: "cancelled", reason: "evaluator-blocked" };
  }

  const version = evaluator.versions[0];
  if (!version) {
    return { type: "cancelled", reason: "version-unavailable" };
  }

  const isDecisionModel = evaluator.type === EvalTemplateType.DECISION_MODEL;
  if (evaluator.type !== EvalTemplateType.LLM_AS_JUDGE && !isDecisionModel) {
    return {
      type: "cancelled",
      reason: `evaluator-type-not-executable:${evaluator.type}`,
    };
  }

  if (!isDecisionModel) {
    const dataType = readOutputDefinitionDataType(version.outputDefinition);
    if (!dataType || !SUPPORTED_LLM_OUTPUT_DATA_TYPES.has(dataType)) {
      return {
        type: "cancelled",
        reason: `output-type-not-executable:${dataType ?? "unknown"}`,
      };
    }
  }

  return {
    type: "v2",
    evaluatorType: isDecisionModel ? "DECISION_MODEL" : "LLM_AS_JUDGE",
    evaluationRuleId: rule?.id ?? null,
    assignmentId: assignment?.id ?? null,
    evaluatorId: evaluator.id,
    scoreName: evaluator.name,
    variableMapping:
      params.mappingOverride ??
      assignment?.variableMapping ??
      version.variableMapping ??
      [],
    version: {
      id: version.id,
      version: version.version,
      prompt: version.prompt,
      promptMessages: version.promptMessages,
      vars: version.vars,
      provider: version.provider,
      model: version.model,
      modelParams: version.modelParams,
      outputDefinition: version.outputDefinition,
      questions: version.questions,
    },
  };
}

/**
 * Resolves the v2 execution behind a job.
 *
 * `jobConfigurationId` is the fallback identity: jobs queued before the migration
 * reused the rule id there, which resolves through the assignment just the same.
 */
export async function resolveV2Execution(params: {
  projectId: string;
  /** The rule id to resolve when the payload carries no identity. */
  jobConfigurationId: string;
  identity?: { evaluatorId?: string | null; evaluationRuleId?: string | null };
  /**
   * Which evaluator families this path may run. A rule assigning anything else
   * resolves to a cancellation, exactly like a row that does not exist.
   */
  evaluatorTypes: EvalTemplateType[];
  /** Manual batch runs address an evaluator directly, with no rule to check. */
  allowRulelessEvaluator?: boolean;
  /** Manual runs are authorized by the user's selection, not by rule status. */
  allowInactiveRule?: boolean;
  /** Manual runs may carry their own mapping instead of the assignment's. */
  mappingOverride?: unknown;
}): Promise<V2ResolutionResult> {
  const { projectId, jobConfigurationId, identity } = params;
  const evaluatorId = identity?.evaluatorId ?? null;
  const evaluationRuleId = identity?.evaluationRuleId ?? null;
  const evaluatorTypeFilter = { in: params.evaluatorTypes };

  // A v2 identity without a rule is only meaningful for manual runs.
  if (evaluatorId && !evaluationRuleId) {
    if (!params.allowRulelessEvaluator) {
      return { type: "cancelled", reason: "rule-identity-missing" };
    }

    const evaluator = await prisma.evaluator.findFirst({
      where: { id: evaluatorId, projectId, type: evaluatorTypeFilter },
      include: evaluatorInclude,
    });
    if (!evaluator) {
      return { type: "cancelled", reason: "evaluator-unavailable" };
    }

    return buildExecution({
      rule: null,
      assignment: null,
      evaluator,
      mappingOverride: params.mappingOverride,
    });
  }

  const resolvedRuleId = evaluationRuleId ?? jobConfigurationId;
  const assignment = await prisma.evaluationRuleEvaluatorAssignment.findFirst({
    where: {
      projectId,
      evaluationRuleId: resolvedRuleId,
      ...(evaluatorId ? { evaluatorId } : {}),
      evaluator: { projectId, type: evaluatorTypeFilter },
    },
    include: {
      evaluationRule: true,
      evaluator: { include: evaluatorInclude },
    },
  });
  if (!assignment) {
    return { type: "cancelled", reason: "assignment-unavailable" };
  }

  const { evaluationRule: rule, evaluator } = assignment;
  const execution = buildExecution({
    rule: { id: rule.id, status: rule.status },
    assignment: { id: assignment.id, variableMapping: assignment.variableMapping },
    evaluator,
    mappingOverride: params.mappingOverride,
  });

  // A manual run may address a rule that is no longer active.
  if (
    params.allowInactiveRule &&
    execution.type === "cancelled" &&
    execution.reason === "rule-not-active"
  ) {
    return buildExecution({
      rule: null,
      assignment: {
        id: assignment.id,
        variableMapping: assignment.variableMapping,
      },
      evaluator,
      mappingOverride: params.mappingOverride,
    });
  }

  return execution;
}
