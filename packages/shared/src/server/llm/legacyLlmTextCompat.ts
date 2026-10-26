// ── LITEFUSE NOTE (authored compatibility facade) ───────────────────────────
// Upstream's evaluator runtime calls its AI-SDK text layer: `generateLLMText`
// (llmText.ts, 710 lines) plus the `ai-sdk/` provider abstraction (23 files,
// 4409 lines) and seven provider packages, `createLLMOutput` (an AI SDK
// \`Output.object`), `mapLegacyLLMCompletionParams`, `compileLangfuseMediaMessages`
// and `generateLangfuseAIText`.
//
// Decision U1: Litefuse does NOT adopt that stack. The evaluator calls go through
// the LLM layer the rest of the product already uses — `fetchLLMCompletion`
// (LangChain-based), which is also what the worker's evaluation path and the
// playground use. This file provides the same symbol names on top of it, so the
// migrated evaluator code compiles and runs without a second LLM stack.
//
// Deviations from that stack, all deliberate:
//   - `generateLLMText` returns zero token usage. Our `fetchLLMCompletion` does not
//     report usage (LangChain, streamUsage disabled), and decision L1 accepts that
//     the test-run cost estimate is not shown rather than changing the shared LLM
//     layer that every other module depends on.
//   - `compileLangfuseMediaMessages` passes messages through. Upstream rewrites
//     them for the AI SDK's provider-specific media handling, which we have no
//     equivalent for; the trace copy is the same list.
//   - `generateLangfuseAIText` always throws, matching upstream's own behaviour
//     when no Langfuse AI model is configured. The AI feature is parked in
//     Litefuse, and every caller is already gated behind an availability check
//     that always reports unavailable.
// ─────────────────────────────────────────────────────────────────────────────

import { type ZodSchema } from "zod/v4";

import { env } from "../../env";
import { fetchLLMCompletion } from "./fetchLLMCompletion";
import {
  type ChatMessage,
  type LLMJSONSchema,
  type ModelParams,
} from "./types";

const CLIENT_INITIATED_NON_STREAMING_LLM_TIMEOUT_CAP_MS = 95_000;

// Finish client-initiated non-streaming calls before the 102-second load balancer
// timeout (copied from upstream; only the env var name differs).
export const getClientInitiatedNonStreamingLlmTimeoutMs = () =>
  Math.min(
    env.LITEFUSE_FETCH_LLM_COMPLETION_TIMEOUT_MS,
    CLIENT_INITIATED_NON_STREAMING_LLM_TIMEOUT_CAP_MS,
  );

export type LLMOutputDescriptor = {
  schema?: ZodSchema | LLMJSONSchema;
};

/** Stands in for the AI SDK's \`Output.object\`: a carrier for the result schema. */
export function createLLMOutput(
  schema?: ZodSchema | LLMJSONSchema,
): LLMOutputDescriptor {
  return { schema };
}

export type LLMConnectionLike = {
  secretKey: string;
  extraHeaders?: string | null;
  baseURL?: string | null;
  config?: Record<string, unknown> | null;
};

export type LegacyLLMCompletionParams = {
  provider: string;
  adapter: ModelParams["adapter"];
  model: string;
  connection: LLMConnectionLike;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  maxRetries?: number;
};

/**
 * Compatibility boundary for persisted/UI Langfuse shapes (upstream keeps the same
 * seam). Maps the UI's model params plus the connection onto the fields our own
 * LLM layer takes.
 */
export function mapLegacyLLMCompletionParams(params: {
  messages: ChatMessage[];
  modelParams: ModelParams;
  connection: LLMConnectionLike;
}): LegacyLLMCompletionParams {
  const { modelParams } = params;

  return {
    provider: modelParams.provider,
    adapter: modelParams.adapter,
    model: modelParams.model,
    connection: params.connection,
    messages: params.messages,
    maxOutputTokens: modelParams.max_tokens,
    temperature: modelParams.temperature,
    topP: modelParams.top_p,
  };
}

export type GenerateLLMTextResult = {
  output: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export async function generateLLMText(
  params: LegacyLLMCompletionParams & {
    output?: LLMOutputDescriptor;
    /** Accepted for call-site compatibility; our layer has no separate trace input. */
    traceInput?: unknown;
    /** Accepted for call-site compatibility; internal tracing is handled by our layer. */
    trace?: unknown;
  },
): Promise<GenerateLLMTextResult> {
  const modelParams: ModelParams = {
    provider: params.provider,
    adapter: params.adapter,
    model: params.model,
    max_tokens: params.maxOutputTokens,
    temperature: params.temperature,
    top_p: params.topP,
  };

  // Zero usage: see the file header (decision L1).
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  if (params.output?.schema) {
    const parsed = await fetchLLMCompletion({
      streaming: false,
      messages: params.messages,
      modelParams,
      llmConnection: params.connection,
      structuredOutputSchema: params.output.schema,
      maxRetries: params.maxRetries ?? 1,
    });
    return { output: parsed, usage };
  }

  const completion = await fetchLLMCompletion({
    streaming: false,
    messages: params.messages,
    modelParams,
    llmConnection: params.connection,
    maxRetries: params.maxRetries ?? 1,
  });

  return {
    output: typeof completion === "string" ? completion : completion.text,
    usage,
  };
}

export async function compileLangfuseMediaMessages(params: {
  projectId: string;
  messages: ChatMessage[];
  adapter: unknown;
}): Promise<{ providerMessages: ChatMessage[]; traceMessages: ChatMessage[] }> {
  return {
    providerMessages: params.messages,
    traceMessages: params.messages,
  };
}

/**
 * Upstream routes this to a Langfuse-run model. Litefuse has no such model and the
 * feature is parked, so this always throws — exactly what upstream does when no
 * model is configured. Callers are gated behind an availability check that reports
 * unavailable, so the throw is unreachable in practice.
 */
export async function generateLangfuseAIText(_params: {
  messages: ChatMessage[];
  model: string;
  maxTokens?: number;
  timeout?: number;
}): Promise<string> {
  throw new Error("Langfuse AI completion model is not configured.");
}
