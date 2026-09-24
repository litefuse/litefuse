import { LLMAdapter } from "@langfuse/shared";

/**
 * Provider presets for the "LLM Connections" settings page.
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
 * Every `baseURL` here was read from the vendor's own documentation; the
 * sources are listed in `docs/model-pricing-verification.md`
 * (section "预设清单"). Providers whose endpoint could not be confirmed from
 * official docs (Groq, Mistral, Volcengine Ark/Doubao, 01.AI/Yi, iFlytek
 * Spark) are intentionally absent — configure those with the "Custom" option.
 */
export type LlmProviderPresetGroup = "international" | "china" | "local";

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
    label: "智谱 GLM (国内站)",
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
    label: "智谱 GLM (国内站, Anthropic 兼容)",
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
    label: "Z.AI GLM (国际站)",
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
    label: "MiniMax 国内站 (OpenAI 兼容)",
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
    label: "MiniMax 国内站 (Anthropic 兼容)",
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
    label: "MiniMax 国际站 (OpenAI 兼容)",
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
    label: "MiniMax 国际站 (Anthropic 兼容)",
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
    label: "Moonshot / Kimi (国内站)",
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
    label: "Moonshot / Kimi (国内站, Anthropic 兼容)",
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
    label: "Moonshot / Kimi (国际站)",
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
    label: "阿里云百炼 Qwen (DashScope)",
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
    label: "阿里云百炼 Qwen (Anthropic 兼容)",
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
    label: "腾讯混元 / TokenHub",
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
    label: "百度千帆 ERNIE",
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
    label: "阶跃星辰 StepFun",
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
    label: "百川智能 Baichuan",
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
  { value: "international", label: "国际厂商" },
  { value: "china", label: "国内厂商" },
  { value: "local", label: "本地部署" },
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
