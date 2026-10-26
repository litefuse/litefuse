import {
  compilePersistedEvalOutputDefinition,
  EvalTemplateType,
  PersistedEvalOutputDefinitionSchema,
} from "@langfuse/shared";
import {
  DefaultEvalModelService,
  getClientInitiatedNonStreamingLlmTimeoutMs,
  getLLMErrorInfo,
  testModelCall,
} from "@langfuse/shared/src/server";

export type EvaluatorPreflightDefinition = {
  name: string;
  type?: EvalTemplateType | null;
  provider?: string | null;
  model?: string | null;
  modelParams?: unknown;
  outputDefinition: unknown;
};

async function prepareEvaluatorDefinition(params: {
  projectId: string;
  template: EvaluatorPreflightDefinition;
}) {
  const modelConfig = await DefaultEvalModelService.fetchValidModelConfig(
    params.projectId,
    params.template.provider ?? undefined,
    params.template.model ?? undefined,
    params.template.modelParams,
  );

  if (!modelConfig.valid) {
    return {
      valid: false as const,
      error: `No valid LLM model found for evaluator "${params.template.name}". ${modelConfig.error}. Configure a connection for this project under Settings → Model Connections (/project/${params.projectId}/settings/llm-connections) before creating llm_as_judge evaluators.`,
    };
  }

  try {
    const parsedOutputDefinition = PersistedEvalOutputDefinitionSchema.parse(
      params.template.outputDefinition,
    );
    return {
      valid: true as const,
      modelConfig: modelConfig.config,
      outputResultSchema: compilePersistedEvalOutputDefinition(
        parsedOutputDefinition,
      ).outputResultSchema,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Invalid evaluator output definition";
    return {
      valid: false as const,
      error: `Model configuration not valid for evaluator "${params.template.name}". ${message}`,
    };
  }
}

export async function getEvaluatorDefinitionConfigurationError(params: {
  projectId: string;
  template: EvaluatorPreflightDefinition;
}): Promise<string | null> {
  if (params.template.type === EvalTemplateType.CODE) return null;

  const prepared = await prepareEvaluatorDefinition(params);
  return prepared.valid ? null : prepared.error;
}

/**
 * Validates an LLM-as-a-judge definition by *making the call*: `testModelCall`
 * below is a REAL provider request (see the COST note in
 * `web/src/features/evals/v2/server/evaluators/evaluatorValidation.ts`, which is
 * the save-time caller).
 *
 * `throwOnOperationalError` splits a failure into the two upstream verdicts:
 *   * a provider verdict about the model (404) is returned as a message, so the
 *     caller can save the evaluator and mark it blocked instead of rejecting it;
 *   * a timeout / retryable operational failure is rethrown, because there is no
 *     verdict to persist and the save must be refused.
 * Callers that omit the option (the reactivate path) keep the older behaviour of
 * always getting a message back.
 */
export async function getEvaluatorDefinitionPreflightError(
  params: {
    projectId: string;
    template: EvaluatorPreflightDefinition;
  },
  options?: {
    throwOnOperationalError?: boolean;
  },
): Promise<string | null> {
  if (params.template.type === EvalTemplateType.CODE) return null;

  const prepared = await prepareEvaluatorDefinition(params);
  if (!prepared.valid) return prepared.error;

  // Some test environments run a built app against seeded local data. In
  // those cases we still want to validate model selection and schema
  // compilation without depending on live provider credentials.
  if (
    process.env.LANGFUSE_SKIP_EVALUATOR_MODEL_CALL_VALIDATION === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.DATABASE_URL?.includes("langfuse_test")
  ) {
    return null;
  }

  try {
    await testModelCall({
      provider: prepared.modelConfig.provider,
      model: prepared.modelConfig.model,
      apiKey: prepared.modelConfig.apiKey,
      modelConfig: prepared.modelConfig.modelParams,
      structuredOutputSchema: prepared.outputResultSchema,
      // LITEFUSE NOTE: upstream passes `timeout` per call. Our LLM layer applies
      // `LITEFUSE_FETCH_LLM_COMPLETION_TIMEOUT_MS` itself — the same value
      // `getClientInitiatedNonStreamingLlmTimeoutMs()` derives — so there is no
      // per-call override to pass.
    });
  } catch (err) {
    const llmError = getLLMErrorInfo(err);
    const isOperationalError =
      !llmError ||
      llmError.isRetryable ||
      llmError.kind === "timeout" ||
      llmError.kind === "abort";
    if (isOperationalError && options?.throwOnOperationalError) {
      throw err;
    }
    // A provider 404 also covers typos, missing model access, and bad base
    // URLs — not just retired models, so don't claim "retired" as fact.
    if (llmError?.statusCode === 404) {
      return `Model configuration not valid for evaluator "${params.template.name}". The provider could not find model '${prepared.modelConfig.model}' — it may be retired, misspelled, or not available to your API key. Update the evaluator's model or the project's default evaluation model.`;
    }
    const message = llmError?.message ?? "An internal error occurred";
    return `Model configuration not valid for evaluator "${params.template.name}". ${message}`;
  }

  return null;
}
