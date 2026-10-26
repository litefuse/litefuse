import {
  EvalTemplateType,
  extractVariables,
  InvalidRequestError,
  observationVariableMappingList,
} from "@langfuse/shared";
import { decrypt } from "@langfuse/shared/encryption";
import {
  createDecisionModelClient,
  decisionModelProfile,
  DefaultEvalModelService,
  getClientInitiatedNonStreamingLlmTimeoutMs,
  getLLMErrorInfo,
  isDecisionModelAdapter,
  logger,
  unsupportedDecisionQuestionTypes,
} from "@langfuse/shared/src/server";
import { getEvaluatorDefinitionPreflightError } from "@/src/features/evals/server/evaluator-preflight";
import { getPromptMessagesValidationError } from "@/src/features/evals/v2/fns/promptMessages/hasInvalidSystemPromptMessage";
import {
  isCodeEvalEnabled,
  isCodeEvalSourceCodeLanguageSupported,
} from "@/src/features/evals/server/isCodeEvalEnabled";
import { getJsonPathCompatibilityWarning } from "@/src/features/evals/utils/json-path-compatibility";
import {
  EvaluatorConfigurationError,
  EvaluatorModelConfigurationError,
} from "./evaluatorErrors";
import { getDecisionModelCapabilityError } from "./decisionModelCapability";
import {
  createDecisionModelProbeFetch,
  isDecisionModelPreflightRequired,
  runDecisionModelPreflight,
  type DecisionModelPreflightModel,
  type DecisionModelProbeObservation,
} from "./decisionModelPreflight";
import type { EvaluatorDefinition } from "./evaluatorTypes";

/**
 * Options a caller passes when it can tell us what is already persisted. Only
 * the decision-model preflight reads them today.
 */
export type EvaluatorValidationOptions = {
  /**
   * Provider+model of the evaluator version currently in the database, when the
   * caller is updating an existing evaluator. `undefined`/`null` means "treat as
   * a new model choice", so create always probes.
   */
  previousDecisionModel?: DecisionModelPreflightModel | null;
};

export function extractEvaluatorPromptVariables(
  promptMessages: Array<{ content: string }>,
) {
  return [
    ...new Set(
      promptMessages.flatMap(({ content }) => extractVariables(content)),
    ),
  ];
}

export function assertEvaluatorVariablesMatchPrompt(params: {
  promptVariables: string[];
  variables: string[];
}) {
  if (
    params.promptVariables.length !== params.variables.length ||
    params.promptVariables.some(
      (variable) => !params.variables.includes(variable),
    )
  ) {
    throw new InvalidRequestError(
      "Evaluator variables must match the prompt variables",
    );
  }
}

export function assertCompleteEvaluatorVariableMapping(params: {
  promptVariables: string[];
  variableMapping: unknown;
}) {
  const parsed = observationVariableMappingList.safeParse(
    params.variableMapping,
  );
  if (!parsed.success) {
    throw new InvalidRequestError("Evaluator variable mapping is invalid");
  }

  for (const mapping of parsed.data) {
    const compatibilityError = getJsonPathCompatibilityWarning(
      mapping.jsonSelector,
    );
    if (compatibilityError) {
      throw new InvalidRequestError(compatibilityError);
    }
  }

  const mappedVariables = parsed.data.map(
    ({ templateVariable }) => templateVariable,
  );
  const duplicateVariables = mappedVariables.filter(
    (variable, index) => mappedVariables.indexOf(variable) !== index,
  );
  if (duplicateVariables.length > 0) {
    throw new InvalidRequestError(
      `Duplicate mappings for evaluator variables: ${[...new Set(duplicateVariables)].join(", ")}`,
    );
  }

  const unknownVariables = mappedVariables.filter(
    (variable) => !params.promptVariables.includes(variable),
  );
  if (unknownVariables.length > 0) {
    throw new InvalidRequestError(
      `Mappings reference unknown evaluator variables: ${unknownVariables.join(", ")}`,
    );
  }

  const missingVariables = params.promptVariables.filter(
    (variable) => !mappedVariables.includes(variable),
  );
  if (missingVariables.length > 0) {
    throw new InvalidRequestError(
      `Missing mappings for evaluator variables: ${missingVariables.join(", ")}`,
    );
  }
}

export async function assertEvaluatorConfigurationValid(
  params: {
    projectId: string;
    name: string;
    definition: EvaluatorDefinition;
  },
  options?: EvaluatorValidationOptions,
) {
  if (params.definition.type === EvalTemplateType.CODE) {
    if (!isCodeEvalEnabled()) {
      throw new EvaluatorConfigurationError(
        "Code evaluations are not enabled for this deployment.",
      );
    }
    if (
      !isCodeEvalSourceCodeLanguageSupported(
        params.definition.sourceCodeLanguage,
      )
    ) {
      throw new EvaluatorConfigurationError(
        "This code evaluator language is not supported by the configured dispatcher.",
      );
    }
    return;
  }

  if (params.definition.type === EvalTemplateType.DECISION_MODEL) {
    await assertDecisionModelDefinitionValid({
      projectId: params.projectId,
      name: params.name,
      definition: params.definition,
      previousModel: options?.previousDecisionModel,
    });
    return;
  }

  const promptMessagesValidationError = getPromptMessagesValidationError(
    params.definition.promptMessages,
  );
  if (promptMessagesValidationError) {
    throw new InvalidRequestError(promptMessagesValidationError);
  }

  const promptVariables = extractEvaluatorPromptVariables(
    params.definition.promptMessages,
  );
  assertEvaluatorVariablesMatchPrompt({
    promptVariables,
    variables: params.definition.vars,
  });
  if (params.definition.variableMapping !== null) {
    assertCompleteEvaluatorVariableMapping({
      promptVariables,
      variableMapping: params.definition.variableMapping,
    });
  }

  if (params.definition.provider !== null) {
    const connection = await DefaultEvalModelService.fetchValidModelConfig(
      params.projectId,
      params.definition.provider,
      params.definition.model ?? undefined,
    );
    if (
      connection.valid &&
      isDecisionModelAdapter(connection.config.apiKey.adapter)
    ) {
      throw new EvaluatorModelConfigurationError(
        `Connection "${params.definition.provider}" is a decision-model connection and cannot be used for LLM-as-a-judge. Choose a text-generation model or switch the evaluator type to decision model.`,
      );
    }
  }

  // ── LLM-as-a-judge save-time preflight (upstream 4.56 semantics) ──────────
  // Upstream `web/src/features/evals/v2/server/evaluators/evaluatorValidation.ts:175-210`
  // replaced the static `getEvaluatorDefinitionConfigurationError` check with
  // `getEvaluatorDefinitionPreflightError(..., { throwOnOperationalError: true })`,
  // i.e. the save itself makes one real provider call and lets the provider
  // falsify the model name.
  //
  // COST: one REAL provider request per save of an LLM-as-a-judge evaluator.
  // There is no "unchanged model" short-circuit here (unlike the decision-model
  // preflight below) — this is upstream's behaviour, deliberately adopted.
  //
  // The three outcomes:
  //   * provider verdict (404 → "could not find model") → an
  //     `EvaluatorModelConfigurationError`, which
  //     `evaluatorService.ts:validateEvaluatorForPersistence` converts into
  //     "save + mark blocked" (`blocked_at` + `EVAL_MODEL_CONFIG_INVALID`).
  //   * timeout / retryable operational failure → the preflight rethrows and the
  //     catch below turns it into an `EvaluatorConfigurationError` ("the
  //     evaluator was not saved"), which is *not* a model-verdict error, so the
  //     save is refused.
  //   * success → nothing.
  try {
    const error = await getEvaluatorDefinitionPreflightError(
      {
        projectId: params.projectId,
        template: {
          name: params.name,
          type: params.definition.type,
          provider: params.definition.provider,
          model: params.definition.model,
          modelParams: params.definition.modelParams,
          outputDefinition: params.definition.outputDefinition,
        },
      },
      { throwOnOperationalError: true },
    );
    if (error) throw new EvaluatorModelConfigurationError(error);
  } catch (error) {
    const llmError = getLLMErrorInfo(error);
    if (llmError?.kind === "timeout") {
      const timeoutSeconds =
        getClientInitiatedNonStreamingLlmTimeoutMs() / 1000;
      throw new EvaluatorConfigurationError(
        `The model did not respond within ${timeoutSeconds} seconds during evaluator validation. The evaluator was not saved. Retry or check the connection and model settings.`,
      );
    }
    if (llmError && (llmError.isRetryable || llmError.kind === "abort")) {
      const message =
        llmError.kind === "abort"
          ? "The model request was aborted during evaluator validation."
          : "The LLM provider could not complete the model request during evaluator validation.";
      throw new EvaluatorConfigurationError(
        `${message} The evaluator was not saved. Retry or check the connection and model settings.`,
      );
    }
    throw error;
  }
}

export async function getDecisionModelConfigurationError(params: {
  projectId: string;
  name: string;
  definition: Pick<
    Extract<EvaluatorDefinition, { type: "DECISION_MODEL" }>,
    "provider" | "model"
  >;
}): Promise<string | null> {
  const modelConfig = await DefaultEvalModelService.fetchValidModelConfig(
    params.projectId,
    params.definition.provider,
    params.definition.model,
  );
  if (!modelConfig.valid) {
    return `No decision-model connection found for evaluator "${params.name}". ${modelConfig.error}. Add a TypeSafe or OpenAI connection under Settings → Model Connections (/project/${params.projectId}/settings/llm-connections) first.`;
  }
  // LITEFUSE ADDITION (gap D4): `supportsDecisionModels` / `isAllowedDecisionModel`
  // answer the adapter *and* the model half of the question, so an unsupported
  // adapter or a decision-model-incapable model is rejected with its own
  // readable reason instead of falling through to the generic adapter message.
  // The existing adapter check below still runs: it is the execution gate, and
  // this one never accepts an adapter that gate rejects.
  //
  // LITEFUSE: decision-model support is narrowed to TypeSafe (LITEFUSE NOTE in
  // `packages/shared/src/server/llm/types.ts`), so both checks below are now the
  // same TypeSafe-only predicate. That is deliberate: the save-time check can no
  // longer pass an adapter (e.g. OpenAI) that the worker execution gate would
  // refuse on the first real run.
  const capabilityError = getDecisionModelCapabilityError({
    provider: params.definition.provider,
    adapter: modelConfig.config.apiKey.adapter,
    model: modelConfig.config.model,
  });
  if (capabilityError) {
    return capabilityError;
  }
  if (!isDecisionModelAdapter(modelConfig.config.apiKey.adapter)) {
    return `Connection "${params.definition.provider}" is not a decision-model connection. Decision-model evaluators need a TypeSafe or OpenAI connection.`;
  }
  return null;
}

async function assertDecisionModelDefinitionValid(params: {
  projectId: string;
  name: string;
  definition: Extract<EvaluatorDefinition, { type: "DECISION_MODEL" }>;
  previousModel?: DecisionModelPreflightModel | null;
}) {
  if (params.definition.vars.length === 0) {
    throw new InvalidRequestError(
      "Decision-model evaluators need at least one state field",
    );
  }
  assertCompleteEvaluatorVariableMapping({
    promptVariables: params.definition.vars,
    variableMapping: params.definition.variableMapping,
  });

  // A provider can be narrower than our schema: Respan's span-01 family answers
  // noul questions only (measured against OpenRouter). Reject unsupported types
  // here so an evaluator is never saved into a state where every run is a
  // provider 400.
  // The domain calls a yes/no question `noul`; the capability helper speaks in
  // wire-neutral names, so normalise before asking.
  const unsupported = unsupportedDecisionQuestionTypes(
    params.definition.model,
    [
      ...new Set(
        params.definition.questions.map((question) =>
          question.type === "noul" ? ("boolean" as const) : question.type,
        ),
      ),
    ],
  );
  if (unsupported.length > 0) {
    const label = (type: string) => (type === "boolean" ? "yes/no" : type);
    throw new InvalidRequestError(
      `Model "${params.definition.model}" cannot answer ${unsupported
        .map(label)
        .join(
          ", ",
        )} questions. Supported question types: ${decisionModelProfile(
        params.definition.model,
      )
        .questionTypes.map(label)
        .join(", ")}. Choose another model or remove those questions.`,
    );
  }

  const error = await getDecisionModelConfigurationError(params);
  if (error) throw new EvaluatorModelConfigurationError(error);

  const preflightError = await getDecisionModelPreflightError({
    projectId: params.projectId,
    name: params.name,
    provider: params.definition.provider,
    model: params.definition.model,
    previousModel: params.previousModel,
  });
  if (preflightError)
    throw new EvaluatorModelConfigurationError(preflightError);
}

/**
 * ── LITEFUSE ADDITION (decision-model save preflight) ──────────────────────
 * The connection gate above only proves that the provider *connection* exists
 * and is decision-model-capable — it never asks the provider whether the model
 * name inside that connection exists. A decision-model evaluator therefore used
 * to save fine with a typo (`not-a-decision-model`) and only fail on the first
 * real run. This mirrors upstream's "let the provider falsify the name" approach
 * (`web/src/features/evals/server/evaluator-preflight.ts` on upstream main) for
 * the decision-model side.
 *
 * COST: the probe is a real Jev call, i.e. one unit of real Jev quota, per save.
 * It is deliberately skipped when the persisted version already uses the same
 * provider+model pair, so renaming an evaluator (or editing its questions or
 * description) spends nothing.
 *
 * INTENTIONAL DEVIATION FROM UPSTREAM: a failure that is *operational* rather
 * than a verdict about the model (transport/proxy failure, timeout, 451 region
 * block, 5xx, or a 4xx that says nothing about the model) does NOT block the
 * save; it is logged as a warning and reported as "saved without verifying"
 * through that log line. Upstream blocks in every failure case (upstream
 * evaluator-validation passes `{ throwOnOperationalError: true }` and turns
 * retryable/timeout errors into "The evaluator was not saved"). Blocking here
 * would make a dropped VPN or a blocked region render evaluators unsavable,
 * which is worse than persisting an unverified model that the user can test
 * explicitly. Only a provider verdict about the model (404, or a body naming the
 * model unknown/invalid/not-available) refuses the save.
 *
 * The warning is log-only on purpose: surfacing it in the mutation response
 * would change the shape the setup UI consumes, which is outside the scope of
 * this change (server-side evaluators only).
 * ───────────────────────────────────────────────────────────────────────────
 */
async function getDecisionModelPreflightError(params: {
  projectId: string;
  name: string;
  provider: string;
  model: string;
  previousModel?: DecisionModelPreflightModel | null;
}): Promise<string | null> {
  if (
    !isDecisionModelPreflightRequired({
      provider: params.provider,
      model: params.model,
      previousModel: params.previousModel,
    })
  ) {
    // Unchanged model: no provider call, no quota. (Create has no previous
    // model, so it always probes.)
    return null;
  }

  // Same escape hatch as the LLM-judge preflight: a built app run against
  // seeded test data must not spend provider quota.
  if (
    process.env.LANGFUSE_SKIP_EVALUATOR_MODEL_CALL_VALIDATION === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.DATABASE_URL?.includes("langfuse_test")
  ) {
    return null;
  }

  // Resolved a second time (the gate above already resolved it): one extra
  // prisma read is cheaper than widening `getDecisionModelConfigurationError`'s
  // return type for every existing caller.
  const modelConfig = await DefaultEvalModelService.fetchValidModelConfig(
    params.projectId,
    params.provider,
    params.model,
  );
  if (!modelConfig.valid) return null;

  const observation: DecisionModelProbeObservation = {};
  const outcome = await runDecisionModelPreflight({
    evaluatorName: params.name,
    provider: params.provider,
    model: params.model,
    previousModel: params.previousModel,
    observation,
    // Built lazily: when the probe is skipped, no client (and no proxy agent) is
    // constructed and no request leaves the process.
    createClient: () =>
      createDecisionModelClient({
        adapter: modelConfig.config.apiKey.adapter,
        apiKey: decrypt(modelConfig.config.apiKey.secretKey),
        model: modelConfig.config.model,
        baseURL: modelConfig.config.apiKey.baseURL,
        fetchImpl: createDecisionModelProbeFetch({
          fetchImpl: fetch,
          timeoutMs: getClientInitiatedNonStreamingLlmTimeoutMs(),
          observation,
        }),
      }),
  });

  switch (outcome.status) {
    case "skipped":
    case "valid":
      return null;
    case "invalid":
      return outcome.message;
    case "unverified":
      logger.warn(
        "Decision-model evaluator save preflight could not verify the model; save allowed",
        {
          projectId: params.projectId,
          evaluatorName: params.name,
          provider: params.provider,
          model: params.model,
          reason: outcome.reason,
          detail: outcome.detail,
          unverified: true,
        },
      );
      return null;
  }
}
