// ── LITEFUSE ADDITION: decision-model client factory ───────────────────────
// Two providers speak decision models with two different wire formats:
// TypeSafe/Jev (System One) and OpenAI (`/v1/decisions`). The worker, the
// save-time preflight, the manual test run and the connection test all need the
// same choice, so it lives here instead of being repeated at each call site.
//
// The adapter is the connection's adapter — the same value the execution gate
// checks — so "which client runs" and "which connections are selectable" can
// never disagree.
// ────────────────────────────────────────────────────────────────────────────

import { LLMAdapter } from "./types";
import { createTypeSafeDecisionModelClient } from "./typesafe/typeSafeDecisionModelClient";
import { createOpenAiDecisionModelClient } from "./openai/openAiDecisionModelClient";
import type { DecisionModelClient } from "../evals/decisionModelEvaluatorExecution";

export function createDecisionModelClient(params: {
  adapter: string;
  apiKey: string;
  model: string;
  baseURL?: string | null;
  fetchImpl?: typeof fetch;
}): DecisionModelClient {
  switch (params.adapter) {
    case LLMAdapter.TypeSafe:
      return createTypeSafeDecisionModelClient({
        apiKey: params.apiKey,
        model: params.model,
        baseURL: params.baseURL,
        fetchImpl: params.fetchImpl,
      });
    case LLMAdapter.OpenAI:
      return createOpenAiDecisionModelClient({
        apiKey: params.apiKey,
        model: params.model,
        baseURL: params.baseURL,
        fetchImpl: params.fetchImpl,
      });
    default:
      throw new Error(
        `Adapter "${params.adapter}" cannot answer decision-model evaluators`,
      );
  }
}
