import { LLMAdapter, typeSafeModels } from "@langfuse/shared";

/**
 * Provider presets for the "Model Connections" settings page.
 *
 * Each preset fills the connection form (adapter + provider name + base URL +
 * model list) so users do not have to look up the OpenAI/Anthropic-compatible
 * endpoint of every provider by hand.
 *
 * IMPORTANT: `customModels[0]` of a preset is the model that
 * `llmApiKey.test` / `testUpdate` calls on the real provider before the
 * connection is stored (see `web/src/features/llm-api-key/server/router.ts`).
 * Keep the first model a valid, cheap, generally available model ID.
 *
 * Every `baseURL` here was read from the vendor's own documentation.
 * Providers whose endpoint could not be confirmed from
 * official docs (Groq, Mistral, Volcengine Ark/Doubao, 01.AI/Yi, iFlytek
 * Spark) are intentionally absent — configure those with the "Custom" option.
 */
export type LlmProviderPresetGroup =
  | "international"
  | "china"
  | "local"
  | "decision-model";

export type LlmProviderPreset = {
  /** Stable id, also used in analytics events. */
  id: string;
  /** Name shown in the preset dropdown. */
  label: string;
  group: LlmProviderPresetGroup;
  /** Request/response schema this endpoint speaks. */
  adapter: LLMAdapter;
  /** Default value for the "Provider name" field (must not contain colons). */
  provider: string;
  /** Default value for the "API Base URL" field; "" means the SDK default. */
  baseURL: string;
  /** Whether the provider's built-in default model list should be enabled. */
  withDefaultModels: boolean;
  /** Custom model names; empty when `withDefaultModels` is used. */
  customModels: string[];
  /** Official documentation for this endpoint. */
  docsUrl: string;
  /** Where the user creates the API key. */
  apiKeyUrl: string;
  /** Short hint shown under the preset selector. */
  note?: string;
  /**
   * Only for decision-model presets: which System One upstream the form should
   * show. Presets whose base URL carries the tenant (Azure Foundry, Alibaba)
   * pick "custom" so the base URL field is visible; the gateway presets pick
   * their gateway. Defaults to the upstream inferred from `baseURL`.
   */
  typeSafeUpstream?: "typesafe" | "vercel-ai-gateway" | "openrouter" | "custom";
};

export const CUSTOM_PRESET_ID = "custom";

export const llmProviderPresets: LlmProviderPreset[] = [
  // ------------------------------------------------------------- International
  {
    id: "openai",
    label: "OpenAI",
    group: "international",
    adapter: LLMAdapter.OpenAI,
    provider: "OpenAI",
    baseURL: "",
    withDefaultModels: true,
    customModels: [],
    docsUrl: "https://platform.openai.com/docs/api-reference",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    note: "Uses Litefuse's built-in OpenAI model list (GPT-5.x, GPT-4.1, o-series).",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude Opus / Sonnet / Haiku)",
    group: "international",
    adapter: LLMAdapter.Anthropic,
    provider: "Anthropic",
    baseURL: "",
    withDefaultModels: true,
    customModels: [],
    docsUrl: "https://platform.claude.com/docs/en/api/overview",
    apiKeyUrl: "https://platform.claude.com/settings/keys",
    note: "Uses Litefuse's built-in Claude list, incl. Claude Opus 5 / Opus 4.6.",
  },
  {
    id: "google-ai-studio",
    label: "Google AI Studio (Gemini)",
    group: "international",
    adapter: LLMAdapter.GoogleAIStudio,
    provider: "Google AI Studio",
    baseURL: "",
    withDefaultModels: true,
    customModels: [],
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    note: "Uses Litefuse's built-in Gemini model list.",
  },
  {
    id: "xai-grok",
    label: "xAI (Grok)",
    group: "international",
    adapter: LLMAdapter.OpenAI,
    provider: "xAI",
    baseURL: "https://api.x.ai/v1",
    withDefaultModels: false,
    customModels: ["grok-4.6", "grok-4.5"],
    docsUrl: "https://docs.x.ai/developers/quickstart",
    apiKeyUrl: "https://console.x.ai/team/default/api-keys",
    note: "US regional endpoint https://us.api.x.ai/v1 is billed at 1.1x.",
  },
  {
    id: "openrouter",
    label: "OpenRouter (multi-vendor gateway)",
    group: "international",
    adapter: LLMAdapter.OpenAI,
    provider: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    withDefaultModels: false,
    customModels: ["openai/gpt-5.2"],
    docsUrl: "https://openrouter.ai/docs/quickstart",
    apiKeyUrl: "https://openrouter.ai/keys",
    note: "Model names use the vendor/model form, e.g. anthropic/claude-opus-4-6.",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    group: "international",
    adapter: LLMAdapter.OpenAI,
    provider: "Fireworks",
    baseURL: "https://api.fireworks.ai/inference/v1",
    withDefaultModels: false,
    customModels: [
      "accounts/fireworks/models/deepseek-v4-pro-0813",
      "accounts/fireworks/models/kimi-k3",
      "accounts/fireworks/models/glm-5p3",
      "accounts/fireworks/models/qwen3p8-max",
    ],
    docsUrl: "https://docs.fireworks.ai/serverless/pricing",
    apiKeyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    note: "Serverless models are addressed as accounts/fireworks/models/<model>.",
  },
  {
    id: "ollama",
    label: "Ollama (local runtime)",
    group: "local",
    adapter: LLMAdapter.OpenAI,
    provider: "Ollama",
    baseURL: "http://localhost:11434/v1",
    withDefaultModels: false,
    customModels: ["gpt-oss:20b"],
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
    apiKeyUrl: "https://docs.ollama.com/",
    note: "Ollama ignores the API key, so any non-empty string works; replace the model with one you have pulled.",
  },

  // ------------------------------------------- Decision models (Jev/TypeSafe)
  {
    id: "typesafe-decision-model",
    label: "TypeSafe / Jev (decision models)",
    group: "decision-model",
    typeSafeUpstream: "typesafe",
    adapter: LLMAdapter.TypeSafe,
    provider: "TypeSafe",
    // Empty means "no gateway": the TypeSafe decision-model client defaults to
    // https://api.typesafe.ai/v1. The connection form turns this into the
    // upstream picker (TypeSafe / Vercel AI Gateway / OpenRouter / Custom).
    baseURL: "",
    withDefaultModels: false,
    customModels: [...typeSafeModels],
    docsUrl: "https://typesafe.ai",
    apiKeyUrl: "https://typesafe.ai",
    note: "Decision model for evaluators, not a text model. Jev is TypeSafe's own System One model; the gateway and vendor presets below reach the same API.",
  },
  {
    id: "microsoft-decision-1-azure",
    label: "Microsoft-Decision-1 (Azure Foundry)",
    group: "decision-model",
    typeSafeUpstream: "custom",
    adapter: LLMAdapter.TypeSafe,
    provider: "Azure",
    // The host carries the Foundry resource, so the user supplies it. The
    // connection stores it without /systemone; the client appends that, and
    // authenticates with the `api-key` header Azure expects.
    baseURL: "",
    withDefaultModels: false,
    customModels: ["microsoft-decision-1"],
    docsUrl:
      "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision",
    apiKeyUrl: "https://ai.azure.com",
    note: "Set the base URL to https://<resource>.cognitiveservices.azure.com/providers/microsoft/v1 and use the deployment name as the model that the evaluator picks. Azure is authenticated with the api-key header.",
  },
  {
    id: "microsoft-decision-1-openrouter",
    label: "Microsoft-Decision-1 (OpenRouter)",
    group: "decision-model",
    typeSafeUpstream: "openrouter",
    adapter: LLMAdapter.TypeSafe,
    provider: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    withDefaultModels: false,
    customModels: ["microsoft/microsoft-decision-1"],
    docsUrl: "https://openrouter.ai/microsoft/microsoft-decision-1",
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    note: "Routed and billed through OpenRouter, so no Azure deployment is needed.",
  },
  {
    id: "liquid-d1-openrouter",
    label: "Liquid AI d1 (OpenRouter)",
    group: "decision-model",
    typeSafeUpstream: "openrouter",
    adapter: LLMAdapter.TypeSafe,
    provider: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    withDefaultModels: false,
    customModels: ["liquid/d1-ultra", "liquid/d1"],
    docsUrl: "https://openrouter.ai/liquid/d1-ultra-20261015",
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    note: "Liquid's decision model exposes the same System One API, so the evaluator behaves like Jev. A self-hosted vLLM deployment (LiquidAI/d1-3B) works through the Custom upstream instead.",
  },
  {
    id: "openrouter-decision-models",
    label: "OpenRouter (all verified decision models)",
    group: "decision-model",
    typeSafeUpstream: "openrouter",
    adapter: LLMAdapter.TypeSafe,
    provider: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    withDefaultModels: false,
    // Every OpenRouter decision model verified against our System One client
    // (see decision-model-e2e.mjs). `openai/gpt-6-luna-decisions` is absent: the
    // provider refuses it over OpenRouter (403 provider ToS) and needs an
    // official OpenAI connection instead.
    customModels: [
      "typesafe/jev-1.14",
      "typesafe/jev-1.13",
      "perplexity/pplx-decider-v1.2",
      "perplexity/pplx-decider-flash-v1.2",
      "perplexity/pplx-decider-latest",
      "perplexity/pplx-decider-flash-latest",
      "respan/span-02",
      "respan/span-01",
      "respan/span-01-lite",
      "respan/span-01-lite:free",
      "liquid/d1-ultra",
      "liquid/d1",
      "scaledown/classify-1",
      "nace-ai/drex-v2.0",
      "nace-ai/drex-v1.5",
      "microsoft/microsoft-decision-1",
      "cloudflare/clef-omni",
      "cloudflare/clef",
      "cloudflare/clef-flash",
      "upstage/solar-decide",
      "upstage/solar-decide-flash",
      "togethercomputer/tev1-4b-experimental",
      "inception/mercury-decide",
      "inception/mercury-decide:free",
      "jaredpalmer/kev-4b",
    ],
    docsUrl: "https://openrouter.ai/models",
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    note: "Pick any model in the list. ScaleDown needs a text state and Respan span-01 a chat state; both are adapted automatically. Respan span-01 answers yes/no questions only, and the evaluator form enforces that.",
  },
  {
    id: "openai-decision-model",
    label: "OpenAI Decisions (gpt-6-luna)",
    group: "decision-model",
    adapter: LLMAdapter.OpenAI,
    provider: "OpenAI",
    // OpenAI serves its decision model at /v1/decisions on the regular API host;
    // the client appends /decisions to this base URL.
    baseURL: "https://api.openai.com/v1",
    withDefaultModels: false,
    customModels: ["gpt-6-luna"],
    docsUrl: "https://developers.openai.com/api/docs/guides/decisions",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    note: "OpenAI's own Decisions API (public beta). It is not the System One protocol: the evaluator form is the same, but this connection can only answer decision-model evaluators. You can also reuse an existing OpenAI connection if it lists gpt-6-luna.",
  },
  {
    id: "perplexity-decider",
    label: "Perplexity Decider (official)",
    group: "decision-model",
    typeSafeUpstream: "custom",
    adapter: LLMAdapter.TypeSafe,
    provider: "Perplexity",
    // Same request/response schema as System One, served at /v1/decisions
    // instead of /v1/systemone; the client appends /decisions for this host.
    baseURL: "https://api.perplexity.ai/v1",
    withDefaultModels: false,
    customModels: [
      "pplx-decider-v1.2",
      "pplx-decider-flash-v1.2",
      "pplx-decider-latest",
      "pplx-decider-flash-latest",
    ],
    docsUrl: "https://docs.perplexity.ai/api-reference/decisions-post",
    apiKeyUrl: "https://www.perplexity.ai/settings/api",
    note: "Perplexity's own Decisions API. The client calls /v1/decisions for this host, so no path editing is needed. Images in the state are supported.",
  },
  {
    id: "upstage-solar-decide",
    label: "Upstage Solar Decide (official)",
    group: "decision-model",
    typeSafeUpstream: "custom",
    adapter: LLMAdapter.TypeSafe,
    provider: "Upstage",
    baseURL: "https://api.upstage.ai/v1",
    withDefaultModels: false,
    customModels: ["solar-decide", "solar-decide-flash"],
    docsUrl: "https://console.upstage.ai/docs/models/solar-decide",
    apiKeyUrl: "https://console.upstage.ai/api-keys",
    note: "Served as a System One endpoint on Solar Mini 4, so every question type works. The flash variant is the cheaper model.",
  },
  {
    id: "liquid-d1",
    label: "Liquid AI d1 (official)",
    group: "decision-model",
    typeSafeUpstream: "custom",
    adapter: LLMAdapter.TypeSafe,
    provider: "Liquid AI",
    baseURL: "https://api.liquid.ai/v1",
    withDefaultModels: false,
    customModels: ["d1", "d1-ultra"],
    docsUrl: "https://docs.liquid.ai",
    apiKeyUrl: "https://dashboard.liquid.ai",
    note: "Liquid's own API. d1-ultra is the larger model; d1 costs less. Self-hosted vLLM deployments use the Custom upstream instead.",
  },
  {
    id: "inception-mercury-decide",
    label: "Inception Mercury Decide (official)",
    group: "decision-model",
    typeSafeUpstream: "custom",
    adapter: LLMAdapter.TypeSafe,
    provider: "Inception",
    baseURL: "https://api.inceptionlabs.ai/v1",
    withDefaultModels: false,
    customModels: ["mercury-decide"],
    docsUrl: "https://docs.inceptionlabs.ai",
    apiKeyUrl: "https://platform.inceptionlabs.ai",
    note: "Inception serves the decision endpoint next to its chat models on the same host.",
  },
  {
    id: "cloudflare-clef",
    label: "Cloudflare Clef (official)",
    group: "decision-model",
    typeSafeUpstream: "custom",
    adapter: LLMAdapter.TypeSafe,
    provider: "Cloudflare",
    // Account-scoped host, so the user supplies the account id.
    baseURL: "",
    withDefaultModels: false,
    customModels: ["clef", "clef-flash"],
    docsUrl: "https://developers.cloudflare.com/workers-ai/models/clef/",
    apiKeyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    note: "Set the base URL to https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1; the model is the short name (clef or clef-flash). clef-omni is only reachable through OpenRouter.",
  },
  {
    id: "alibaba-bailian-decision",
    label: "Alibaba Bailian decision model",
    group: "decision-model",
    typeSafeUpstream: "custom",
    adapter: LLMAdapter.TypeSafe,
    provider: "Alibaba",
    // Workspace-scoped host, so the user supplies it.
    baseURL: "",
    withDefaultModels: false,
    customModels: ["decision-model-preview"],
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/decision-model-api",
    apiKeyUrl:
      "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
    note: "Set the base URL to https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1 and keep the model at decision-model-preview.",
  },

  // ------------------------------------------------------------------- China
  {
    id: "deepseek",
    label: "DeepSeek (OpenAI-compatible)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    withDefaultModels: false,
    customModels: ["deepseek-v4-pro", "deepseek-flash", "deepseek-v4-flash"],
    docsUrl: "https://api-docs.deepseek.com/",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    note: "deepseek-v4-flash is a legacy alias served by DeepSeek-V4.1-Flash.",
  },
  {
    id: "deepseek-anthropic",
    label: "DeepSeek (Anthropic-compatible)",
    group: "china",
    adapter: LLMAdapter.Anthropic,
    provider: "DeepSeek",
    baseURL: "https://api.deepseek.com/anthropic",
    withDefaultModels: false,
    customModels: ["deepseek-v4-pro", "deepseek-flash"],
    docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "zhipu-glm",
    label: "Zhipu GLM (China)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "Zhipu",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    withDefaultModels: false,
    customModels: ["glm-5.3", "glm-5.3-flash", "glm-5.2"],
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
    apiKeyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "zhipu-glm-anthropic",
    label: "Zhipu GLM (China, Anthropic-compatible)",
    group: "china",
    adapter: LLMAdapter.Anthropic,
    provider: "Zhipu",
    baseURL: "https://open.bigmodel.cn/api/anthropic",
    withDefaultModels: false,
    customModels: ["glm-5.3", "glm-5.3-flash"],
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/claude/introduction",
    apiKeyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "zai-glm-intl",
    label: "Z.AI GLM (International)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "ZAI",
    baseURL: "https://api.z.ai/api/paas/v4",
    withDefaultModels: false,
    customModels: ["glm-5.3", "glm-5.3-flash"],
    docsUrl: "https://docs.z.ai/guides/develop/openai/python",
    apiKeyUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    id: "minimax-cn",
    label: "MiniMax (China, OpenAI-compatible)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "MiniMax",
    baseURL: "https://api.minimax.cn/v1",
    withDefaultModels: false,
    customModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    docsUrl: "https://platform.minimax.cn/docs/api-reference/text-openai-api",
    apiKeyUrl:
      "https://platform.minimax.cn/user-center/basic-information/interface-key",
  },
  {
    id: "minimax-cn-anthropic",
    label: "MiniMax (China, Anthropic-compatible)",
    group: "china",
    adapter: LLMAdapter.Anthropic,
    provider: "MiniMax",
    baseURL: "https://api.minimax.cn/anthropic",
    withDefaultModels: false,
    customModels: ["MiniMax-M3"],
    docsUrl:
      "https://platform.minimax.cn/docs/api-reference/text-anthropic-api",
    apiKeyUrl:
      "https://platform.minimax.cn/user-center/basic-information/interface-key",
  },
  {
    id: "minimax-intl",
    label: "MiniMax (International, OpenAI-compatible)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "MiniMax",
    baseURL: "https://api.minimax.io/v1",
    withDefaultModels: false,
    customModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-openai-api",
    apiKeyUrl:
      "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    id: "minimax-intl-anthropic",
    label: "MiniMax (International, Anthropic-compatible)",
    group: "china",
    adapter: LLMAdapter.Anthropic,
    provider: "MiniMax",
    baseURL: "https://api.minimax.io/anthropic",
    withDefaultModels: false,
    customModels: ["MiniMax-M3"],
    docsUrl:
      "https://platform.minimax.io/docs/api-reference/text-anthropic-api",
    apiKeyUrl:
      "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    id: "moonshot-kimi",
    label: "Moonshot / Kimi (China)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "Moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    withDefaultModels: false,
    customModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
    docsUrl: "https://platform.kimi.com/docs/api/overview",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
  },
  {
    id: "moonshot-kimi-anthropic",
    label: "Moonshot / Kimi (China, Anthropic-compatible)",
    group: "china",
    adapter: LLMAdapter.Anthropic,
    provider: "Moonshot",
    baseURL: "https://api.moonshot.cn/anthropic",
    withDefaultModels: false,
    customModels: ["kimi-k3", "kimi-k2.6"],
    docsUrl: "https://platform.kimi.com/docs/api/messages",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
  },
  {
    id: "moonshot-kimi-intl",
    label: "Moonshot / Kimi (International)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "Moonshot",
    baseURL: "https://api.moonshot.ai/v1",
    withDefaultModels: false,
    customModels: ["kimi-k3"],
    docsUrl: "https://platform.kimi.ai/docs/api/overview",
    apiKeyUrl: "https://platform.kimi.ai/console/api-keys",
  },
  {
    id: "qwen-dashscope",
    label: "Alibaba Cloud Bailian Qwen (DashScope)",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "Qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    withDefaultModels: false,
    customModels: ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"],
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    apiKeyUrl:
      "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
    note: "Litefuse disables DashScope thinking mode by default (enable_thinking=false).",
  },
  {
    id: "qwen-dashscope-anthropic",
    label: "Alibaba Cloud Bailian Qwen (Anthropic-compatible)",
    group: "china",
    adapter: LLMAdapter.Anthropic,
    provider: "Qwen",
    baseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
    withDefaultModels: false,
    customModels: ["qwen3.8-max", "qwen3.7-plus"],
    docsUrl: "https://help.aliyun.com/zh/model-studio/claude-code",
    apiKeyUrl:
      "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
    note: "This base URL must not end in /v1.",
  },
  {
    id: "tencent-tokenhub",
    label: "Tencent Hunyuan / TokenHub",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "Tencent",
    baseURL: "https://tokenhub.tencentmaas.com/v1",
    withDefaultModels: false,
    customModels: ["hy3", "hy4-preview"],
    docsUrl: "https://cloud.tencent.com/document/product/1823/130055",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/apikey",
    note: "The legacy api.hunyuan.cloud.tencent.com endpoint stops serving on 2026-09-30.",
  },
  {
    id: "baidu-qianfan",
    label: "Baidu Qianfan ERNIE",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "Baidu",
    baseURL: "https://qianfan.baidubce.com/v2",
    withDefaultModels: false,
    customModels: ["ernie-5.1"],
    docsUrl: "https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/",
  },
  {
    id: "stepfun",
    label: "StepFun",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "StepFun",
    baseURL: "https://api.stepfun.com/v1",
    withDefaultModels: false,
    customModels: ["step-3.7-flash", "step-5-preview"],
    docsUrl: "https://platform.stepfun.com/docs/zh/guides/pricing/details",
    apiKeyUrl: "https://platform.stepfun.com/interface-key",
  },
  {
    id: "baichuan",
    label: "Baichuan",
    group: "china",
    adapter: LLMAdapter.OpenAI,
    provider: "Baichuan",
    baseURL: "https://api.baichuan-ai.com/v1",
    withDefaultModels: false,
    customModels: ["Baichuan-M3", "Baichuan-M3-Plus"],
    docsUrl: "https://platform.baichuan-ai.com/prices",
    apiKeyUrl: "https://platform.baichuan-ai.com/console/apikey",
  },
];

export const presetGroups: Array<{
  value: LlmProviderPresetGroup;
  label: string;
}> = [
  { value: "international", label: "International providers" },
  { value: "china", label: "China providers" },
  // Decision models are their own family: they do not generate text, so they
  // cannot sit next to the chat-completion providers.
  { value: "decision-model", label: "Decision models" },
  { value: "local", label: "Local / self-hosted" },
];

export function getLlmProviderPreset(
  id: string | null | undefined,
): LlmProviderPreset | undefined {
  if (!id || id === CUSTOM_PRESET_ID) return undefined;
  return llmProviderPresets.find((preset) => preset.id === id);
}

export function groupLlmProviderPresets(): Array<{
  group: LlmProviderPresetGroup;
  label: string;
  presets: LlmProviderPreset[];
}> {
  return presetGroups.map(({ value, label }) => ({
    group: value,
    label,
    presets: llmProviderPresets.filter((preset) => preset.group === value),
  }));
}

/**
 * Best-effort reverse lookup used when editing an existing connection so the
 * preset dropdown can show which preset the stored connection matches.
 */
export function inferLlmProviderPresetId(params: {
  adapter: string;
  baseURL?: string | null;
}): string {
  const normalizedBaseURL = (params.baseURL ?? "").replace(/\/+$/, "");

  const match = llmProviderPresets.find(
    (preset) =>
      preset.adapter === params.adapter &&
      (preset.baseURL ?? "").replace(/\/+$/, "") === normalizedBaseURL,
  );

  return match?.id ?? CUSTOM_PRESET_ID;
}
