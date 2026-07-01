import { describe, expect, it } from "vitest";
import {
  resolveAnthropicCompatibleProviderHandler,
  resolveOpenAICompatibleProviderHandler,
  processAnthropicCompatibleBaseURL,
  stripThinkingFromObject,
  stripThinkingFromText,
} from "../handlers";
import { LLMAdapter } from "../types";

describe("OpenAI-compatible provider handlers", () => {
  it("returns null for non-OpenAI adapters", () => {
    const handler = resolveOpenAICompatibleProviderHandler({
      adapter: LLMAdapter.Anthropic,
      provider: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });

    expect(handler).toBeNull();
  });

  it("disables thinking by default for Qwen and uses functionCalling for structured output", () => {
    const handler = resolveOpenAICompatibleProviderHandler({
      adapter: LLMAdapter.OpenAI,
      provider: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });

    expect(handler?.id).toBe("qwen-openai");

    const config = handler?.buildConfig({
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelName: "qwen3.6-flash",
      providerOptions: undefined,
      hasStructuredOutput: true,
    });

    expect(config).toEqual({
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelKwargs: {
        enable_thinking: false,
      },
      structuredOutput: {
        method: "functionCalling",
      },
    });
  });

  it("preserves explicit Qwen thinking overrides", () => {
    const handler = resolveOpenAICompatibleProviderHandler({
      adapter: LLMAdapter.OpenAI,
      provider: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });

    const config = handler?.buildConfig({
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelName: "qwen3.6-flash",
      providerOptions: {
        enable_thinking: true,
      },
      hasStructuredOutput: false,
    });

    expect(config?.modelKwargs).toEqual({
      enable_thinking: true,
    });
  });

  it("disables thinking by default for Qwen Anthropic-compatible endpoints", () => {
    const handler = resolveAnthropicCompatibleProviderHandler({
      adapter: LLMAdapter.Anthropic,
      provider: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages",
    });

    expect(handler?.id).toBe("qwen-anthropic");

    const config = handler?.buildConfig({
      baseURL: "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages",
      modelName: "qwen3.6-flash",
      providerOptions: undefined,
      hasStructuredOutput: true,
    });

    expect(config?.baseURL).toBe(
      "https://dashscope.aliyuncs.com/apps/anthropic",
    );
    expect(config?.invocationKwargs).toEqual({
      thinking: { type: "disabled" },
    });
    expect(config?.thinkingBlockTypes).toBeUndefined();
  });

  it("marks Qwen Anthropic as thinking-capable when explicitly enabled", () => {
    const handler = resolveAnthropicCompatibleProviderHandler({
      adapter: LLMAdapter.Anthropic,
      provider: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
    });

    const config = handler?.buildConfig({
      baseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
      modelName: "qwen3.6-flash",
      providerOptions: {
        thinking: { type: "enabled", budget_tokens: 256 },
      },
      hasStructuredOutput: false,
    });

    expect(config?.invocationKwargs).toEqual({
      thinking: { type: "enabled", budget_tokens: 256 },
    });
    expect(Array.from(config?.thinkingBlockTypes ?? [])).toEqual(["thinking"]);
  });

  it("enables reasoning_split by default for MiniMax, uses functionCalling for structured output, and strips thinking tags from text", () => {
    const handler = resolveOpenAICompatibleProviderHandler({
      adapter: LLMAdapter.OpenAI,
      provider: "minimax",
      baseURL: "https://api.minimaxi.com/v1",
    });

    expect(handler?.id).toBe("minimax-openai");

    const config = handler?.buildConfig({
      baseURL: "https://api.minimaxi.com/v1",
      modelName: "MiniMax-M2.7",
      providerOptions: undefined,
      hasStructuredOutput: true,
    });

    expect(config).toEqual({
      baseURL: "https://api.minimaxi.com/v1",
      modelKwargs: {
        reasoning_split: true,
      },
      structuredOutput: {
        method: "functionCalling",
      },
    });

    expect(
      handler?.normalizeTextCompletion?.("<think>reasoning</think>\n\n4"),
    ).toBe("4");
  });

  it("preserves explicit MiniMax reasoning_split overrides", () => {
    const handler = resolveOpenAICompatibleProviderHandler({
      adapter: LLMAdapter.OpenAI,
      provider: "minimax",
      baseURL: "https://api.minimaxi.com/v1",
    });

    const config = handler?.buildConfig({
      baseURL: "https://api.minimaxi.com/v1",
      modelName: "MiniMax-M2.7",
      providerOptions: {
        reasoning_split: false,
      },
      hasStructuredOutput: false,
    });

    expect(config?.modelKwargs).toEqual({
      reasoning_split: false,
    });
  });

  it("disables thinking for MiniMax Anthropic structured output on M2 models", () => {
    const handler = resolveAnthropicCompatibleProviderHandler({
      adapter: LLMAdapter.Anthropic,
      provider: "minimax",
      baseURL: "https://api.minimax.io/anthropic/v1/messages",
    });

    expect(handler?.id).toBe("minimax-anthropic");

    const config = handler?.buildConfig({
      baseURL: "https://api.minimax.io/anthropic/v1/messages",
      modelName: "MiniMax-M2.7",
      providerOptions: undefined,
      hasStructuredOutput: true,
    });

    expect(config?.baseURL).toBe("https://api.minimax.io/anthropic");
    expect(config?.invocationKwargs).toEqual({
      thinking: { type: "disabled" },
    });
    expect(config?.structuredOutput).toEqual({
      method: "functionCalling",
    });
    expect(config?.thinkingBlockTypes).toBeUndefined();
  });

  it("keeps MiniMax Anthropic M2 models thinking-capable for non-structured calls", () => {
    const handler = resolveAnthropicCompatibleProviderHandler({
      adapter: LLMAdapter.Anthropic,
      provider: "minimax",
      baseURL: "https://api.minimax.io/anthropic/v1/messages",
    });

    const config = handler?.buildConfig({
      baseURL: "https://api.minimax.io/anthropic/v1/messages",
      modelName: "MiniMax-M2.7",
      providerOptions: undefined,
      hasStructuredOutput: false,
    });

    expect(config?.baseURL).toBe("https://api.minimax.io/anthropic");
    expect(config?.invocationKwargs).toEqual({});
    expect(Array.from(config?.thinkingBlockTypes ?? [])).toEqual(["thinking"]);
  });

  it("disables thinking by default for MiniMax Anthropic M3 models", () => {
    const handler = resolveAnthropicCompatibleProviderHandler({
      adapter: LLMAdapter.Anthropic,
      provider: "minimax",
      baseURL: "https://api.minimax.io/anthropic",
    });

    const config = handler?.buildConfig({
      baseURL: "https://api.minimax.io/anthropic",
      modelName: "MiniMax-M3",
      providerOptions: undefined,
      hasStructuredOutput: false,
    });

    expect(config?.invocationKwargs).toEqual({
      thinking: { type: "disabled" },
    });
    expect(config?.thinkingBlockTypes).toBeUndefined();
  });

  it("strips MiniMax thinking tags from tool-call content without touching tool_calls", () => {
    const handler = resolveOpenAICompatibleProviderHandler({
      adapter: LLMAdapter.OpenAI,
      provider: "minimax",
      baseURL: "https://api.minimaxi.com/v1",
    });

    const normalized = handler?.normalizeToolCallResponse?.({
      content:
        "<think>The user wants to know the weather in Paris.</think>\n\n",
      tool_calls: [
        {
          id: "call_123",
          name: "get_weather",
          args: {
            location: "Paris",
          },
        },
      ],
    });

    expect(normalized).toEqual({
      content: "",
      tool_calls: [
        {
          id: "call_123",
          name: "get_weather",
          args: {
            location: "Paris",
          },
        },
      ],
    });
  });

  it("cleans nested thinking tags from structured outputs", () => {
    expect(
      stripThinkingFromObject({
        answer: "<think>reasoning</think>4",
        nested: {
          reasoning: "prefix<think>hidden</think>suffix",
        },
      }),
    ).toEqual({
      answer: "4",
      nested: {
        reasoning: "prefixsuffix",
      },
    });
  });

  it("normalizes generic OpenAI-compatible base URLs", () => {
    const handler = resolveOpenAICompatibleProviderHandler({
      adapter: LLMAdapter.OpenAI,
      provider: "custom",
      baseURL: "https://proxy.example.com/openai/{model}",
    });

    const templatedConfig = handler?.buildConfig({
      baseURL: "https://proxy.example.com/openai/{model}",
      modelName: "custom-model",
      providerOptions: undefined,
      hasStructuredOutput: false,
    });

    const miniMaxLegacyConfig = handler?.buildConfig({
      baseURL: "https://api.minimax.example.com/v1/text/chatcompletion_v2",
      modelName: "custom-model",
      providerOptions: undefined,
      hasStructuredOutput: false,
    });

    expect(templatedConfig?.baseURL).toBe(
      "https://proxy.example.com/openai/custom-model",
    );
    expect(miniMaxLegacyConfig?.baseURL).toBe(
      "https://api.minimax.example.com",
    );
    expect(stripThinkingFromText("before<think>hidden</think>after")).toBe(
      "beforeafter",
    );
  });

  it("normalizes Anthropic-compatible messages endpoints", () => {
    expect(
      processAnthropicCompatibleBaseURL(
        "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages",
      ),
    ).toBe("https://dashscope.aliyuncs.com/apps/anthropic");

    expect(
      processAnthropicCompatibleBaseURL(
        "https://api.minimax.io/anthropic/v1/messages",
      ),
    ).toBe("https://api.minimax.io/anthropic");
  });
});
