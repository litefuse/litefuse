import { LlmApiKeys } from "@prisma/client";
import z from "zod/v4";
import { JSONObjectSchema } from "../../utils/zod";

// disable lint as this is exported and used in web/worker

export const LLMJSONSchema = z.record(z.string(), z.any());
export type LLMJSONSchema = z.infer<typeof LLMJSONSchema>;

export const JSONSchemaFormSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      const parsed = JSON.parse(value);
      return parsed;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Parameters must be valid JSON",
      });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.any()),
        required: z.array(z.string()).optional(),
        additionalProperties: z.boolean().optional(),
      })
      .passthrough()
      .transform((data) => JSON.stringify(data, null, 2)),
  );

export const LLMToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: LLMJSONSchema,
});
export type LLMToolDefinition = z.infer<typeof LLMToolDefinitionSchema>;

const AnthropicMessageContentWithToolUse = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
]);

const GoogleAIStudioMessageContentWithToolUse = z.object({
  functionCall: z.object({
    name: z.string(),
    args: z.unknown(),
  }),
});

export const LLMToolCallSchema = z.object({
  name: z.string(),
  id: z.string(),
  args: z
    .record(z.string(), z.unknown())
    .nullable()
    .transform((val) => val ?? {}),
});
export type LLMToolCall = z.infer<typeof LLMToolCallSchema>;

export const OpenAIToolCallSchema = z.object({
  id: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.union([
      z.record(z.string(), z.unknown()),
      z
        .string()
        .transform((v) => {
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        })
        .pipe(z.record(z.string(), z.unknown())),
    ]),
  }),
  type: z.literal("function"),
});
export type OpenAIToolCallSchema = z.infer<typeof OpenAIToolCallSchema>;

export const OpenAIToolSchema = z.object({
  type: z.literal("function"),
  function: LLMToolDefinitionSchema,
});
export type OpenAIToolSchema = z.infer<typeof OpenAIToolSchema>;

export const OpenAIResponseFormatSchema = z.object({
  type: z.literal("json_schema"),
  json_schema: z.object({
    name: z.string(),
    schema: LLMJSONSchema,
  }),
});

export const ToolCallResponseSchema = z.object({
  content: z.union([
    z.string(),
    z.array(AnthropicMessageContentWithToolUse),
    z.array(GoogleAIStudioMessageContentWithToolUse),
  ]),
  tool_calls: z.array(LLMToolCallSchema),
});
export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;
export enum ChatMessageRole {
  System = "system",
  Developer = "developer",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
  Model = "model", // Google Gemini assistant format
}

// Thought: should placeholder not semantically be part of this, because it can be
// PublicAPICreated of type? Works for now though.
export enum ChatMessageType {
  System = "system",
  Developer = "developer",
  User = "user",
  AssistantText = "assistant-text",
  AssistantToolCall = "assistant-tool-call",
  ToolResult = "tool-result",
  ModelText = "model-text",
  PublicAPICreated = "public-api-created",
  Placeholder = "placeholder",
}

export const SystemMessageSchema = z.object({
  type: z.literal(ChatMessageType.System),
  role: z.literal(ChatMessageRole.System),
  content: z.string(),
});
export type SystemMessage = z.infer<typeof SystemMessageSchema>;

export const DeveloperMessageSchema = z.object({
  type: z.literal(ChatMessageType.Developer),
  role: z.literal(ChatMessageRole.Developer),
  content: z.string(),
});
export type DeveloperMessage = z.infer<typeof DeveloperMessageSchema>;

export const UserMessageSchema = z.object({
  type: z.literal(ChatMessageType.User),
  role: z.literal(ChatMessageRole.User),
  content: z.string(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantTextMessageSchema = z.object({
  type: z.literal(ChatMessageType.AssistantText),
  role: z.literal(ChatMessageRole.Assistant),
  content: z.string(),
});
export type AssistantTextMessage = z.infer<typeof AssistantTextMessageSchema>;

export const ModelMessageSchema = z.object({
  type: z.literal(ChatMessageType.ModelText),
  role: z.literal(ChatMessageRole.Model),
  content: z.string(),
});
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const AssistantToolCallMessageSchema = z.object({
  type: z.literal(ChatMessageType.AssistantToolCall),
  role: z.literal(ChatMessageRole.Assistant),
  content: z.string(),
  toolCalls: z.array(LLMToolCallSchema),
});
export type AssistantToolCallMessage = z.infer<
  typeof AssistantToolCallMessageSchema
>;

export const ToolResultMessageSchema = z.object({
  type: z.literal(ChatMessageType.ToolResult),
  role: z.literal(ChatMessageRole.Tool),
  content: z.string(),
  toolCallId: z.string(),
});
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;

export const PlaceholderMessageSchema = z.object({
  type: z.literal(ChatMessageType.Placeholder),
  name: z
    .string()
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      "Placeholder name must start with a letter and contain only alphanumeric characters and underscores",
    ),
});
export type PlaceholderMessage = z.infer<typeof PlaceholderMessageSchema>;

export const ChatMessageDefaultRoleSchema = z.enum(ChatMessageRole);
export const ChatMessageSchema = z.union([
  SystemMessageSchema,
  DeveloperMessageSchema,
  UserMessageSchema,
  AssistantTextMessageSchema,
  AssistantToolCallMessageSchema,
  ToolResultMessageSchema,
  ModelMessageSchema,
  z
    .object({
      role: z.union([ChatMessageDefaultRoleSchema, z.string()]), // Users may ingest any string as role via API/SDK
      content: z.union([z.string(), z.array(z.any()), z.any()]), // Support arbitrary content types for message placeholders
    })
    .transform((msg) => {
      return {
        ...msg,
        type: ChatMessageType.PublicAPICreated as const,
      };
    }),
]);

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatMessageWithId =
  | (ChatMessage & { id: string })
  | (PlaceholderMessage & { id: string });
export type ChatMessageWithIdNoPlaceholders = ChatMessage & { id: string };

export const PromptChatMessageSchema = z.union([
  z.object({
    role: z.string(),
    content: z.string(),
  }),
  PlaceholderMessageSchema,
]);
export const PromptChatMessageListSchema = z.array(PromptChatMessageSchema);

export type PromptVariable = { name: string; value: string; isUsed: boolean };

export enum LLMAdapter {
  Anthropic = "anthropic",
  OpenAI = "openai",
  // Azure = "azure",
  // Bedrock = "bedrock",
  // VertexAI = "google-vertex-ai",
  GoogleAIStudio = "google-ai-studio",
  // Decision-model (Jev) connections. Upstream carries this member in the same
  // enum, and a decision-model connection is an ordinary `llm_api_keys` row whose
  // adapter is this value. Added so the connection form can create one; see
  // `DECISION_MODEL_ADAPTERS` below for what may run on it.
  TypeSafe = "typesafe",
}

/** Adapters that can answer decision-model evaluators. */
export const DECISION_MODEL_ADAPTERS: readonly LLMAdapter[] = [
  LLMAdapter.TypeSafe,
  LLMAdapter.OpenAI,
];

export function isDecisionModelAdapterType(adapter: string): boolean {
  return DECISION_MODEL_ADAPTERS.includes(adapter as LLMAdapter);
}

// ── LITEFUSE NOTE: two decision-model providers, two wire formats ────────────
// Upstream 4.56 exposes two decision-model adapters: TypeSafe (System One, Jev)
// and OpenAI (the hosted Decisions API, `gpt-6-luna`). This fork matches that
// surface, but implements both clients by hand instead of through the AI SDK:
//
//   * `.../llm/typesafe/typeSafeDecisionModelClient.ts` — POST /systemone
//   * `.../llm/openai/openAiDecisionModelClient.ts`     — POST /decisions
//   * `.../llm/createDecisionModelClient.ts`            — picks one by adapter
//
// All four call sites (worker execution, save-time preflight, manual test run,
// connection test) go through that factory, so the adapter gate
// (`isDecisionModelAdapter` / `DECISION_MODEL_ADAPTERS`), the selector filter and
// the execution path always agree.
//
// The OpenAI endpoint is NOT System One: `input` instead of `state`, `predicate`
// instead of `noul`, ordered `questions`/`answers` arrays instead of keyed
// objects, `choices`/`levels` arrays instead of criteria, and probabilities as
// `[{ value, probability }]`. The OpenAI client absorbs all of that; the rest of
// the pipeline keeps seeing the same domain types.
//
// Difference that remains: a TypeSafe connection accepts any model name (the
// model version is free text, `jev-latest` by default), while an OpenAI
// connection is restricted to `OPENAI_DECISION_MODEL_IDS` — a typo there would
// only surface as a provider 404 on the first real run.
// ─────────────────────────────────────────────────────────────────────────────

export const OPENAI_DECISION_MODEL_IDS: readonly string[] = ["gpt-6-luna"];

/**
 * Adapters that can answer a decision-model evaluator: TypeSafe (System One) and
 * OpenAI (Decisions API).
 */
export function supportsDecisionModels(adapter: string): boolean {
  return isDecisionModelAdapterType(adapter);
}

/**
 * Whether a model may be used for decision models on that adapter.
 *
 * TypeSafe allows any non-empty name (the Jev model version is free text);
 * OpenAI allows only `OPENAI_DECISION_MODEL_IDS`.
 */
export function isAllowedDecisionModel(
  adapter: string,
  model: string,
): boolean {
  // TypeSafe stores a free-text model version (`jev-latest` by default), so any
  // non-empty name is allowed there. OpenAI's decision models are an allowlist:
  // only the hosted ids this client knows how to call.
  if (adapter === LLMAdapter.TypeSafe) return model.length > 0;
  if (adapter === LLMAdapter.OpenAI) {
    return OPENAI_DECISION_MODEL_IDS.includes(model);
  }
  return false;
}

export const TextPromptContentSchema = z.string().min(1, "Enter a prompt");

export const PromptContentSchema = z.union([
  PromptChatMessageListSchema,
  TextPromptContentSchema,
]);
export type PromptContent = z.infer<typeof PromptContentSchema>;

export type ModelParams = {
  provider: string;
  adapter: LLMAdapter;
  model: string;
} & ModelConfig;

type RecordWithEnabledFlag<T> = {
  [K in keyof T]: { value: T[K]; enabled: boolean };
};
export type UIModelParams = RecordWithEnabledFlag<
  Required<ModelParams> & {
    maxTemperature: number;
  }
>;

// Generic config
export type ModelConfig = z.infer<typeof ZodModelConfig>;
export const ZodModelConfig = z.object({
  max_tokens: z.coerce.number().optional(),
  temperature: z.coerce.number().optional(),
  top_p: z.coerce.number().optional(),
  maxReasoningTokens: z.coerce.number().optional(),
  providerOptions: JSONObjectSchema.optional(),
});

// Experiment config
export const ExperimentMetadataSchema = z
  .object({
    prompt_id: z.string(),
    provider: z.string(),
    model: z.string(),
    model_params: ZodModelConfig,
    structured_output_schema: LLMJSONSchema.optional(),
    experiment_name: z.string().optional(),
    experiment_run_name: z.string().optional(),
    error: z.string().optional(),
    dataset_version: z.coerce.date().optional(),
  })
  .strict();
export type ExperimentMetadata = z.infer<typeof ExperimentMetadataSchema>;

// NOTE: Update docs page when changing this! https://litefuse.ai/docs/prompt-management/features/playground#openai-playground--anthropic-playground
// WARNING: The first entry in the array is chosen as the default model to add LLM API keys
export const openAIModels = [
  "gpt-4.1",
  "gpt-4.1-2025-04-14",
  "gpt-4.1-mini",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano",
  "gpt-4.1-nano-2025-04-14",
  "gpt-5.4",
  "gpt-5.4-2026-03-05",
  "gpt-5.4-pro",
  "gpt-5.4-pro-2026-03-05",
  "gpt-5.2-2025-12-11",
  "gpt-5.1",
  "gpt-5.1-2025-11-13",
  "gpt-5",
  "gpt-5-2025-08-07",
  "gpt-5-mini",
  "gpt-5-mini-2025-08-07",
  "gpt-5-nano",
  "gpt-5-nano-2025-08-07",
  "o3",
  "o3-2025-04-16",
  "o4-mini",
  "o4-mini-2025-04-16",
  "gpt-4o",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-05-13",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18",
  "o3-mini",
  "o3-mini-2025-01-31",
  "o1-preview",
  "o1-preview-2024-09-12",
  "o1-mini",
  "o1-mini-2024-09-12",
  "gpt-4.5-preview",
  "gpt-4.5-preview-2025-02-27",
  "gpt-4-turbo-preview",
  "gpt-4-1106-preview",
  "gpt-4-0613",
  "gpt-4-0125-preview",
  "gpt-4",
  "gpt-3.5-turbo-16k-0613",
  "gpt-3.5-turbo-16k",
  "gpt-3.5-turbo-1106",
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-0301",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo",
] as const;

type OpenAIReasoningMap = Record<OpenAIModel, boolean>;
export const openAIModelToReasoning: OpenAIReasoningMap = {
  // reasoning models
  "gpt-5.4": true,
  "gpt-5.4-2026-03-05": true,
  "gpt-5.4-pro": true,
  "gpt-5.4-pro-2026-03-05": true,
  "gpt-5.2-2025-12-11": true,
  "gpt-5.1": true,
  "gpt-5.1-2025-11-13": true,
  "gpt-5": true,
  "gpt-5-2025-08-07": true,
  "gpt-5-mini": true,
  "gpt-5-mini-2025-08-07": true,
  "gpt-5-nano": true,
  "gpt-5-nano-2025-08-07": true,
  o3: true,
  "o3-2025-04-16": true,
  "o4-mini": true,
  "o4-mini-2025-04-16": true,
  "o3-mini": true,
  "o3-mini-2025-01-31": true,
  "o1-preview": true,
  "o1-preview-2024-09-12": true,
  "o1-mini": true,
  "o1-mini-2024-09-12": true,
  // non-reasoning models
  "gpt-4.5-preview": false,
  "gpt-4.5-preview-2025-02-27": false,
  "gpt-4-turbo-preview": false,
  "gpt-4-1106-preview": false,
  "gpt-4-0613": false,
  "gpt-4-0125-preview": false,
  "gpt-4": false,
  "gpt-3.5-turbo-16k-0613": false,
  "gpt-3.5-turbo-16k": false,
  "gpt-3.5-turbo-1106": false,
  "gpt-3.5-turbo-0613": false,
  "gpt-3.5-turbo-0301": false,
  "gpt-3.5-turbo-0125": false,
  "gpt-3.5-turbo": false,
  "gpt-4.1": false,
  "gpt-4.1-2025-04-14": false,
  "gpt-4.1-mini": false,
  "gpt-4.1-mini-2025-04-14": false,
  "gpt-4.1-nano": false,
  "gpt-4.1-nano-2025-04-14": false,
  "gpt-4o": false,
  "gpt-4o-2024-08-06": false,
  "gpt-4o-2024-05-13": false,
  "gpt-4o-mini": false,
  "gpt-4o-mini-2024-07-18": false,
};

export const isOpenAIReasoningModel = (model: OpenAIModel): boolean => {
  return openAIModelToReasoning[model];
};

export type OpenAIModel = (typeof openAIModels)[number];

// NOTE: Update docs page when changing this! https://litefuse.ai/docs/prompt-management/features/playground#openai-playground--anthropic-playground
// WARNING: The first entry in the array is chosen as the default model to add LLM API keys
export const anthropicModels = [
  "claude-sonnet-4-5-20250929",
  // Current Claude line-up (Opus 5 / Sonnet 5 / Haiku 4.5) so the Anthropic
  // preset in LLM Connections exposes the newest Opus models as well.
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-20250514",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-20240620",
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-3-5-haiku-20241022",
  "claude-3-haiku-20240307",
  "claude-2.1",
  "claude-2.0",
  "claude-instant-1.2",
] as const;

// WARNING: The first entry in the array is chosen as the default model to add LLM API keys. Make sure it supports top_p, max_tokens and temperature.
export const googleAIStudioModels = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-lite-preview-09-2025",
  "gemini-2.0-flash",
  "gemini-2.0-flash-thinking-exp-01-21",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
] as const;

export type AnthropicModel = (typeof anthropicModels)[number];

/**
 * Models served by TypeSafe's decision-model API. These are not text models: a
 * decision model returns structured answers and is executed by the decision-model
 * evaluator, never by `fetchLLMCompletion`.
 *
 * List follows upstream main, which dropped `jev-1.13.0` in favour of the
 * `jev-latest` alias.
 */
export const typeSafeModels = ["jev-latest"] as const;

/**
 * Providers that serve Jev through TypeSafe's `/v1/systemone` API. A TypeSafe
 * connection stores a gateway's `baseURL`, or none for TypeSafe itself, which
 * the AI SDK provider then defaults to. Presets only prefill the base URL; a
 * `custom` connection stores any base URL the provider appends `/systemone`
 * to.
 */
export const TYPESAFE_UPSTREAMS = [
  {
    id: "typesafe",
    label: "TypeSafe",
    baseURL: null,
    apiKeyLabel: "TypeSafe API key",
    /** Model ids this upstream serves by default. */
    models: ["jev-latest"],
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    baseURL: "https://ai-gateway.vercel.sh/typesafe/v1",
    apiKeyLabel: "Vercel AI Gateway API key",
    models: ["jev-latest"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    // The gateway fans out to every System One provider it carries, so the
    // model id selects the vendor: Jev, Liquid AI d1, Microsoft-Decision-1.
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyLabel: "OpenRouter API key",
    models: ["jev-latest", "liquid/d1-ultra", "microsoft/microsoft-decision-1"],
  },
  {
    id: "custom",
    label: "Custom",
    baseURL: null,
    apiKeyLabel: "API key",
    /**
     * No defaults: the base URL carries the tenant. Known System One hosts:
     *   Azure Foundry  https://<resource>.cognitiveservices.azure.com/providers/microsoft/v1
     *                  (authenticated with an `api-key` header, not Bearer)
     *   Alibaba        https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1
     *                  model `decision-model-preview`
     *   liquid / vLLM  https://<host>/v1  (model `LiquidAI/d1-3B`)
     */
    models: [],
  },
] as const;

export type TypeSafeUpstream = (typeof TYPESAFE_UPSTREAMS)[number];

/**
 * Maps a stored base URL back to the upstream card it came from. An empty base
 * URL is TypeSafe itself; any unknown base URL is a `custom` gateway.
 */
export function resolveTypeSafeUpstream(
  baseURL: string | null | undefined,
): TypeSafeUpstream {
  if (!baseURL) return TYPESAFE_UPSTREAMS[0];
  return (
    TYPESAFE_UPSTREAMS.find((upstream) => upstream.baseURL === baseURL) ??
    TYPESAFE_UPSTREAMS[TYPESAFE_UPSTREAMS.length - 1]
  );
}

export const supportedModels = {
  [LLMAdapter.Anthropic]: anthropicModels,
  [LLMAdapter.OpenAI]: openAIModels,
  [LLMAdapter.GoogleAIStudio]: googleAIStudioModels,
  [LLMAdapter.TypeSafe]: typeSafeModels,
} as const;

export type LLMFunctionCall = {
  name: string;
  description: string;
  parameters: z.ZodTypeAny; // this has to be a json schema for OpenAI
};

export const LLMApiKeySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
    adapter: z.enum(LLMAdapter),
    provider: z.string(),
    displaySecretKey: z.string(),
    secretKey: z.string(),
    extraHeaders: z.string().nullish(),
    extraHeaderKeys: z.array(z.string()),
    baseURL: z.string().nullable(),
    customModels: z.array(z.string()),
    withDefaultModels: z.boolean(),
    config: z.any().nullish(),
  })
  // strict mode to prevent extra keys. Thorws error otherwise
  // https://github.com/colinhacks/zod?tab=readme-ov-file#strict
  .strict();

export type LLMApiKey =
  z.infer<typeof LLMApiKeySchema> extends LlmApiKeys
    ? z.infer<typeof LLMApiKeySchema>
    : never;

export enum LangfuseInternalTraceEnvironment {
  PromptExperiments = "langfuse-prompt-experiment",
  // Added for the evaluators v2 migration; same value as upstream.
  CodeEval = "langfuse-code-eval",
  LLMJudge = "langfuse-llm-as-a-judge",
}

/**
 * Details of a generation extracted from traced events.
 * Used to pass generation information from internal tracing to callbacks.
 */
export type GenerationDetails = {
  observationId: string;
  name: string;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
};

export type TraceSinkParams = {
  /**
   * IMPORTANT: This controls into what project the resulting traces are ingested.
   */
  targetProjectId: string;
  traceId: string;
  traceName: string;
  // NOTE: These strings must be whitelisted in the TS SDK to allow ingestion of traces by Langfuse. Please mirror edits to this string in https://github.com/selectdb/langfuse-doris-js/blob/main/langfuse-core/src/index.ts.
  environment: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  prompt?: {
    name: string;
    version: number;
  };
  /**
   * Optional callback invoked after the generation events have been processed.
   * Called with merged generation details (from create + update events).
   */
  onGenerationComplete?: (details: GenerationDetails) => void;
};
