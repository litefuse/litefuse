import {
  type AnthropicCompatibleProviderHandler,
  type OpenAICompatibleProviderHandler,
  getHostname,
  isAnthropicThinkingEnabled,
  isDashScopeHost,
  mergeProviderOptions,
  normalizeProviderName,
  processAnthropicCompatibleBaseURL,
  processOpenAICompatibleBaseURL,
} from "./shared";

function matchesQwenProvider(params: {
  provider?: string;
  baseURL?: string | null;
}): boolean {
  const normalizedProvider = normalizeProviderName(params.provider);
  const hostname = getHostname(params.baseURL);

  return normalizedProvider === "qwen" || isDashScopeHost(hostname);
}

export const qwenOpenAICompatibleProviderHandler: OpenAICompatibleProviderHandler =
  {
    id: "qwen-openai",
    matches: matchesQwenProvider,
    buildConfig: ({
      baseURL,
      modelName,
      providerOptions,
      hasStructuredOutput,
    }) => {
      const modelKwargs = mergeProviderOptions(
        {
          enable_thinking: false,
        },
        providerOptions,
      );

      return {
        baseURL: processOpenAICompatibleBaseURL({
          url: baseURL,
          modelName,
        }),
        modelKwargs,
        // DashScope's OpenAI-compatible endpoint rejects json_object/json_schema
        // structured output unless the prompt contains explicit "json" wording.
        structuredOutput: hasStructuredOutput
          ? { method: "functionCalling" }
          : undefined,
      };
    },
  };

export const qwenAnthropicCompatibleProviderHandler: AnthropicCompatibleProviderHandler =
  {
    id: "qwen-anthropic",
    matches: matchesQwenProvider,
    buildConfig: ({ baseURL, providerOptions }) => {
      const invocationKwargs = mergeProviderOptions(
        {
          thinking: { type: "disabled" },
        },
        providerOptions,
      );

      return {
        baseURL: processAnthropicCompatibleBaseURL(baseURL),
        invocationKwargs,
        thinkingBlockTypes: isAnthropicThinkingEnabled(invocationKwargs)
          ? new Set(["thinking"])
          : undefined,
      };
    },
  };
