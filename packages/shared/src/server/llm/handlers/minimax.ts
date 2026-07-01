import {
  type AnthropicCompatibleProviderHandler,
  type OpenAICompatibleProviderHandler,
  getHostname,
  isAnthropicThinkingEnabled,
  isMiniMaxM3Model,
  mergeProviderOptions,
  normalizeProviderName,
  normalizeToolCallResponseContent,
  processAnthropicCompatibleBaseURL,
  processOpenAICompatibleBaseURL,
  stripThinkingFromObject,
  stripThinkingFromText,
} from "./shared";

function matchesMiniMaxProvider(params: {
  provider?: string;
  baseURL?: string | null;
}): boolean {
  const normalizedProvider = normalizeProviderName(params.provider);
  const hostname = getHostname(params.baseURL);

  return normalizedProvider === "minimax" || hostname === "api.minimaxi.com";
}

function hasExplicitThinkingConfig(
  providerOptions?: Record<string, unknown>,
): boolean {
  return providerOptions != null && "thinking" in providerOptions;
}

export const miniMaxOpenAICompatibleProviderHandler: OpenAICompatibleProviderHandler =
  {
    id: "minimax-openai",
    matches: matchesMiniMaxProvider,
    buildConfig: ({
      baseURL,
      modelName,
      providerOptions,
      hasStructuredOutput,
    }) => ({
      baseURL: processOpenAICompatibleBaseURL({
        url: baseURL,
        modelName,
      }),
      modelKwargs: mergeProviderOptions(
        {
          reasoning_split: true,
        },
        providerOptions,
      ),
      // MiniMax often returns markdown-wrapped content for jsonSchema mode;
      // function calling yields stable machine-parsable output for evals.
      structuredOutput: hasStructuredOutput
        ? { method: "functionCalling" }
        : undefined,
    }),
    normalizeTextCompletion: stripThinkingFromText,
    normalizeStructuredOutput: stripThinkingFromObject,
    normalizeToolCallResponse: (response) =>
      normalizeToolCallResponseContent(response, stripThinkingFromText),
  };

export const miniMaxAnthropicCompatibleProviderHandler: AnthropicCompatibleProviderHandler =
  {
    id: "minimax-anthropic",
    matches: matchesMiniMaxProvider,
    buildConfig: ({
      baseURL,
      modelName,
      providerOptions,
      hasStructuredOutput,
    }) => {
      const invocationKwargs = hasStructuredOutput
        ? {
            ...(providerOptions ?? {}),
            thinking: { type: "disabled" },
          }
        : mergeProviderOptions(
            isMiniMaxM3Model(modelName)
              ? { thinking: { type: "disabled" } }
              : {},
            providerOptions,
          );

      const thinkingEnabled = hasStructuredOutput
        ? false
        : hasExplicitThinkingConfig(invocationKwargs)
          ? isAnthropicThinkingEnabled(invocationKwargs)
          : !isMiniMaxM3Model(modelName);

      return {
        baseURL: processAnthropicCompatibleBaseURL(baseURL),
        invocationKwargs,
        structuredOutput: hasStructuredOutput
          ? { method: "functionCalling" }
          : undefined,
        thinkingBlockTypes: thinkingEnabled ? new Set(["thinking"]) : undefined,
      };
    },
  };
