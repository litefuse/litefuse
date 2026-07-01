import type { ToolCallResponse } from "../types";

export type StructuredOutputMethod = "functionCalling" | "jsonSchema";

export type ProviderHandlerMatchContext = {
  provider?: string;
  baseURL?: string | null;
};

export type OpenAICompatibleProviderBuildContext =
  ProviderHandlerMatchContext & {
    modelName: string;
    providerOptions?: Record<string, unknown>;
    hasStructuredOutput: boolean;
  };

export type AnthropicCompatibleProviderBuildContext =
  ProviderHandlerMatchContext & {
    modelName: string;
    providerOptions?: Record<string, unknown>;
    hasStructuredOutput: boolean;
  };

type BaseProviderConfig = {
  baseURL?: string | null;
  structuredOutput?: {
    method: StructuredOutputMethod;
  };
  thinkingBlockTypes?: Set<string>;
};

export type OpenAICompatibleProviderConfig = BaseProviderConfig & {
  modelKwargs?: Record<string, unknown>;
};

export type AnthropicCompatibleProviderConfig = BaseProviderConfig & {
  invocationKwargs?: Record<string, unknown>;
};

type BaseProviderHandler = {
  id: string;
  matches: (context: ProviderHandlerMatchContext) => boolean;
  normalizeTextCompletion?: (completion: string) => string;
  normalizeStructuredOutput?: (output: unknown) => unknown;
  normalizeToolCallResponse?: (response: ToolCallResponse) => ToolCallResponse;
};

export type OpenAICompatibleProviderHandler = BaseProviderHandler & {
  buildConfig: (
    context: OpenAICompatibleProviderBuildContext,
  ) => OpenAICompatibleProviderConfig;
};

export type AnthropicCompatibleProviderHandler = BaseProviderHandler & {
  buildConfig: (
    context: AnthropicCompatibleProviderBuildContext,
  ) => AnthropicCompatibleProviderConfig;
};

export const THINKING_TAG_REGEX = /<think>[\s\S]*?<\/think>/gi;

export function normalizeProviderName(provider: string | undefined): string {
  return provider?.trim().toLowerCase() ?? "";
}

export function getHostname(
  baseURL: string | null | undefined,
): string | undefined {
  if (!baseURL) return undefined;

  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function mergeProviderOptions(
  defaults: Record<string, unknown>,
  providerOptions?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...defaults,
    ...(providerOptions ?? {}),
  };
}

export function stripThinkingFromText(text: string): string {
  return text.replace(THINKING_TAG_REGEX, "").trim();
}

export function stripThinkingFromObject(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(THINKING_TAG_REGEX, "");
  }
  if (Array.isArray(obj)) {
    return obj.map(stripThinkingFromObject);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = stripThinkingFromObject(value);
    }
    return result;
  }
  return obj;
}

export function normalizeToolCallResponseContent(
  response: ToolCallResponse,
  normalizeText: (text: string) => string,
): ToolCallResponse {
  return {
    ...response,
    content:
      typeof response.content === "string"
        ? normalizeText(response.content)
        : response.content,
  };
}

export function processOpenAICompatibleBaseURL(params: {
  url: string | null | undefined;
  modelName: string;
}): string | null | undefined {
  const { url, modelName } = params;

  if (!url) return url;

  if (url.includes("{model}")) {
    return url.replace("{model}", modelName);
  }

  const miniMaxCompletionsPaths = ["/v1/text/chatcompletion_v2"];

  for (const path of miniMaxCompletionsPaths) {
    if (url.endsWith(path)) {
      return url.slice(0, -path.length);
    }
  }

  return url;
}

export function processAnthropicCompatibleBaseURL(
  url: string | null | undefined,
): string | null | undefined {
  if (!url) return url;

  const normalizedMessagesPath = ["/v1/messages", "/messages"];

  for (const path of normalizedMessagesPath) {
    if (url.endsWith(path)) {
      return url.slice(0, -path.length);
    }
  }

  return url;
}

export function isAnthropicThinkingEnabled(
  invocationKwargs?: Record<string, unknown>,
): boolean {
  const thinking = invocationKwargs?.thinking;

  if (!thinking || typeof thinking !== "object") {
    return false;
  }

  return (thinking as { type?: string }).type !== "disabled";
}

export function isDashScopeHost(hostname: string | undefined): boolean {
  return (
    hostname === "dashscope.aliyuncs.com" ||
    hostname === "dashscope-intl.aliyuncs.com"
  );
}

export function isMiniMaxM3Model(modelName: string): boolean {
  return modelName.startsWith("MiniMax-M3");
}
