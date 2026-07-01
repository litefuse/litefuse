import { LLMAdapter } from "../types";
import { defaultAnthropicCompatibleProviderHandler } from "./defaultAnthropic";
import { defaultOpenAICompatibleProviderHandler } from "./defaultOpenAI";
import {
  miniMaxAnthropicCompatibleProviderHandler,
  miniMaxOpenAICompatibleProviderHandler,
} from "./minimax";
import {
  qwenAnthropicCompatibleProviderHandler,
  qwenOpenAICompatibleProviderHandler,
} from "./qwen";
import type {
  AnthropicCompatibleProviderHandler,
  AnthropicCompatibleProviderConfig,
  OpenAICompatibleProviderConfig,
  OpenAICompatibleProviderHandler,
  ProviderHandlerMatchContext,
  StructuredOutputMethod,
} from "./shared";

const openAICompatibleProviderHandlers: OpenAICompatibleProviderHandler[] = [
  qwenOpenAICompatibleProviderHandler,
  miniMaxOpenAICompatibleProviderHandler,
  defaultOpenAICompatibleProviderHandler,
];

const anthropicCompatibleProviderHandlers: AnthropicCompatibleProviderHandler[] =
  [
    qwenAnthropicCompatibleProviderHandler,
    miniMaxAnthropicCompatibleProviderHandler,
    defaultAnthropicCompatibleProviderHandler,
  ];

function resolveProviderHandler<
  T extends { matches: (context: ProviderHandlerMatchContext) => boolean },
>(handlers: T[], context: ProviderHandlerMatchContext): T {
  return (
    handlers.find((handler) => handler.matches(context)) ??
    handlers[handlers.length - 1]!
  );
}

export function resolveOpenAICompatibleProviderHandler(context: {
  adapter: LLMAdapter;
  provider?: string;
  baseURL?: string | null;
}): OpenAICompatibleProviderHandler | null {
  if (context.adapter !== LLMAdapter.OpenAI) {
    return null;
  }

  return resolveProviderHandler(openAICompatibleProviderHandlers, context);
}

export function resolveAnthropicCompatibleProviderHandler(context: {
  adapter: LLMAdapter;
  provider?: string;
  baseURL?: string | null;
}): AnthropicCompatibleProviderHandler | null {
  if (context.adapter !== LLMAdapter.Anthropic) {
    return null;
  }

  return resolveProviderHandler(anthropicCompatibleProviderHandlers, context);
}

export {
  processAnthropicCompatibleBaseURL,
  processOpenAICompatibleBaseURL,
  stripThinkingFromObject,
  stripThinkingFromText,
  THINKING_TAG_REGEX,
  type AnthropicCompatibleProviderConfig,
  type AnthropicCompatibleProviderHandler,
  type OpenAICompatibleProviderConfig,
  type OpenAICompatibleProviderHandler,
  type ProviderHandlerMatchContext,
  type StructuredOutputMethod,
} from "./shared";
