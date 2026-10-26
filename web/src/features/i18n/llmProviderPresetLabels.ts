import { i18nKey } from "./i18nKey";

/**
 * Provider-preset labels for the "Model Connections" form.
 *
 * `CreateLLMApiKeyForm` renders these through `t()`, but the strings live as
 * data in `features/llm-api-key/providerPresets.ts` — a plain module with no
 * access to the translator — so they cannot be wrapped at their declaration.
 * This inventory is what the extractor (`i18next.config.ts` lists `i18nKey` as
 * an extraction function) and `removeUnusedKeys` need to keep them, the same
 * arrangement as `sharedEvalLabels.ts` and `sharedExportSourceLabels.ts`.
 *
 * Brand names stay in Latin script in both locales; only the region and
 * compatibility descriptors are translated. Keep this list in sync with
 * `llmProviderPresets[].label` and `presetGroups[].label`.
 */
export const LLM_PROVIDER_PRESET_LABELS = [
  // ---------------------------------------------------------------- groups
  i18nKey("International providers"),
  i18nKey("China providers"),
  i18nKey("Decision models"),
  i18nKey("Local / self-hosted"),

  // ------------------------------------------------- international providers
  i18nKey("OpenAI"),
  i18nKey("Anthropic (Claude Opus / Sonnet / Haiku)"),
  i18nKey("Google AI Studio (Gemini)"),
  i18nKey("xAI (Grok)"),
  i18nKey("OpenRouter (multi-vendor gateway)"),
  i18nKey("Fireworks AI"),
  i18nKey("Ollama (local runtime)"),
  i18nKey("TypeSafe / Jev (decision models)"),
  i18nKey("Microsoft-Decision-1 (Azure Foundry)"),
  i18nKey("Microsoft-Decision-1 (OpenRouter)"),
  i18nKey("Liquid AI d1 (official)"),
  i18nKey("Liquid AI d1 (OpenRouter)"),
  i18nKey("Perplexity Decider (official)"),
  i18nKey("OpenAI Decisions (gpt-6-luna)"),
  i18nKey("Upstage Solar Decide (official)"),
  i18nKey("Inception Mercury Decide (official)"),
  i18nKey("Cloudflare Clef (official)"),
  i18nKey("Alibaba Bailian decision model"),
  i18nKey("OpenRouter (all verified decision models)"),
  i18nKey("DeepSeek (OpenAI-compatible)"),
  i18nKey("DeepSeek (Anthropic-compatible)"),

  // ------------------------------------------------------- China providers
  i18nKey("Zhipu GLM (China)"),
  i18nKey("Zhipu GLM (China, Anthropic-compatible)"),
  i18nKey("Z.AI GLM (International)"),
  i18nKey("MiniMax (China, OpenAI-compatible)"),
  i18nKey("MiniMax (China, Anthropic-compatible)"),
  i18nKey("MiniMax (International, OpenAI-compatible)"),
  i18nKey("MiniMax (International, Anthropic-compatible)"),
  i18nKey("Moonshot / Kimi (China)"),
  i18nKey("Moonshot / Kimi (China, Anthropic-compatible)"),
  i18nKey("Moonshot / Kimi (International)"),
  i18nKey("Alibaba Cloud Bailian Qwen (DashScope)"),
  i18nKey("Alibaba Cloud Bailian Qwen (Anthropic-compatible)"),
  i18nKey("Tencent Hunyuan / TokenHub"),
  i18nKey("Baidu Qianfan ERNIE"),
  i18nKey("StepFun"),
  i18nKey("Baichuan"),

  // ------------------------------------------------------ form chrome (same
  // dropdown, previously hardcoded English)
  i18nKey("Custom (configure manually)"),
];
