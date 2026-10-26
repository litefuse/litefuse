import {
  isAllowedDecisionModel,
  LLMAdapter,
  OPENAI_DECISION_MODEL_IDS,
  supportedModels,
  supportsDecisionModels,
} from "@langfuse/shared";

/**
 * LITEFUSE ADDITION (gap D4): wires the capability predicates
 * (`supportsDecisionModels` / `isAllowedDecisionModel`, both in
 * `packages/shared/src/server/llm/types.ts`) into the decision-model evaluator
 * validation path. They answer "can this connection answer a decision-model
 * question at all, and is this specific model allowed to?" — a question the
 * adapter-only check (`isDecisionModelAdapter`) cannot answer, because it says
 * nothing about the model.
 *
 * Decision-model support covers two adapters: TypeSafe (System One) and OpenAI
 * (the hosted Decisions API, model allowlisted through
 * `OPENAI_DECISION_MODEL_IDS`). Each has a client in this package's
 * `server/llm` folder, dispatched by `createDecisionModelClient`.
 */
export function getAllowedDecisionModelIds(adapter: string): string[] {
  if (adapter === LLMAdapter.TypeSafe) {
    return [...supportedModels[LLMAdapter.TypeSafe]];
  }
  if (adapter === LLMAdapter.OpenAI) {
    return [...OPENAI_DECISION_MODEL_IDS];
  }
  return [];
}

/**
 * Returns a user-readable reason why `adapter`/`model` cannot be used for a
 * decision-model evaluator, or `null` when the connection is capable.
 */
export function getDecisionModelCapabilityError(params: {
  provider: string;
  adapter: string;
  model: string | null | undefined;
}): string | null {
  const model = params.model ?? "";

  if (!supportsDecisionModels(params.adapter)) {
    // Every adapter except TypeSafe and OpenAI: those two are the only ones with
    // a decision-model client.
    return (
      `Connection "${params.provider}" uses adapter "${params.adapter}", which cannot answer ` +
      `decision-model questions. Decision-model evaluators need a TypeSafe or OpenAI ` +
      `connection — add one under Settings → Model Connections first.`
    );
  }

  if (!isAllowedDecisionModel(params.adapter, model)) {
    // An empty model name on TypeSafe, or a model outside OpenAI's allowlist.
    const allowed = getAllowedDecisionModelIds(params.adapter);
    return (
      `Model "${model}" cannot answer decision-model questions on connection ` +
      `"${params.provider}" (adapter "${params.adapter}"). Allowed decision models for this ` +
      `adapter: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`
    );
  }

  return null;
}
