import { LLMAdapter } from "@langfuse/shared";
import {
  CUSTOM_PRESET_ID,
  getLlmProviderPreset,
  groupLlmProviderPresets,
  inferLlmProviderPresetId,
  llmProviderPresets,
} from "@/src/features/llm-api-key/providerPresets";

describe("llmProviderPresets", () => {
  it("offers at least 10 provider presets (was 3 adapters before)", () => {
    expect(llmProviderPresets.length).toBeGreaterThanOrEqual(10);
  });

  it("has globally unique preset ids", () => {
    const ids = llmProviderPresets.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not reuse the reserved custom id", () => {
    expect(llmProviderPresets.map((p) => p.id)).not.toContain(CUSTOM_PRESET_ID);
  });

  it("has unique (adapter, baseURL) pairs so presets stay distinguishable", () => {
    const keys = llmProviderPresets.map(
      (preset) => `${preset.adapter}|${preset.baseURL.replace(/\/+$/, "")}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only uses adapters the LLMAdapter enum knows", () => {
    const knownAdapters = new Set(Object.values(LLMAdapter));

    for (const preset of llmProviderPresets) {
      expect(knownAdapters.has(preset.adapter)).toBe(true);
    }
  });

  it("uses provider names that satisfy the connection schema", () => {
    // web/src/features/llm-api-key/types.ts rejects colons in provider names
    for (const preset of llmProviderPresets) {
      expect(preset.provider.length).toBeGreaterThan(0);
      expect(preset.provider).not.toContain(":");
      expect(preset.provider.trim()).toBe(preset.provider);
    }
  });

  it("has a label, docs link and api key link for every preset", () => {
    for (const preset of llmProviderPresets) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(() => new URL(preset.docsUrl)).not.toThrow();
      expect(() => new URL(preset.apiKeyUrl)).not.toThrow();
    }
  });

  it("ships model names exactly when default models are disabled", () => {
    // Mirrors the form-level refine: default models OR at least one custom model
    for (const preset of llmProviderPresets) {
      if (preset.withDefaultModels) {
        expect(preset.customModels).toEqual([]);
        continue;
      }

      expect(preset.customModels.length).toBeGreaterThan(0);

      for (const model of preset.customModels) {
        expect(model.length).toBeGreaterThan(0);
        expect(model).toBe(model.trim());
      }
    }
  });

  it("uses a valid base URL or an empty string for SDK defaults", () => {
    for (const preset of llmProviderPresets) {
      if (preset.baseURL === "") {
        // Only the native adapters may rely on the SDK default base URL
        expect([
          LLMAdapter.OpenAI,
          LLMAdapter.Anthropic,
          LLMAdapter.GoogleAIStudio,
        ]).toContain(preset.adapter);
        continue;
      }

      const parsed = new URL(preset.baseURL);
      expect(["http:", "https:"]).toContain(parsed.protocol);
    }
  });

  it("covers the providers required by the product brief", () => {
    const allText = llmProviderPresets
      .map((preset) =>
        [
          preset.id,
          preset.label,
          preset.provider,
          preset.baseURL,
          ...preset.customModels,
        ].join(" "),
      )
      .join(" ")
      .toLowerCase();

    // DeepSeek
    expect(allText).toContain("deepseek");
    // Claude Opus (Anthropic preset uses Litefuse's built-in Claude list)
    const anthropicPreset = llmProviderPresets.find(
      (preset) => preset.id === "anthropic",
    );
    expect(anthropicPreset).toBeDefined();
    expect(anthropicPreset!.label).toContain("Opus");
    // 智谱 GLM
    expect(allText).toContain("glm");
    expect(allText).toContain("bigmodel.cn");
    // MiniMax
    expect(allText).toContain("minimax");
  });

  it("groups every preset exactly once", () => {
    const grouped = groupLlmProviderPresets().flatMap((group) =>
      group.presets.map((preset) => preset.id),
    );

    expect(grouped.sort()).toEqual(
      llmProviderPresets.map((preset) => preset.id).sort(),
    );

    for (const group of groupLlmProviderPresets()) {
      expect(group.presets.length).toBeGreaterThan(0);
    }
  });

  it("resolves presets by id and treats custom/unknown ids as manual", () => {
    for (const preset of llmProviderPresets) {
      expect(getLlmProviderPreset(preset.id)?.id).toBe(preset.id);
    }

    expect(getLlmProviderPreset(CUSTOM_PRESET_ID)).toBeUndefined();
    expect(getLlmProviderPreset("does-not-exist")).toBeUndefined();
    expect(getLlmProviderPreset(null)).toBeUndefined();
    expect(getLlmProviderPreset(undefined)).toBeUndefined();
  });

  it("infers the matching preset from a stored connection", () => {
    for (const preset of llmProviderPresets) {
      expect(
        inferLlmProviderPresetId({
          adapter: preset.adapter,
          baseURL: preset.baseURL,
        }),
      ).toBe(preset.id);

      // Stored base URLs may have a trailing slash
      if (preset.baseURL !== "") {
        expect(
          inferLlmProviderPresetId({
            adapter: preset.adapter,
            baseURL: `${preset.baseURL}/`,
          }),
        ).toBe(preset.id);
      }
    }
  });

  it("falls back to custom for unknown connections and matches SDK defaults", () => {
    expect(
      inferLlmProviderPresetId({
        adapter: LLMAdapter.OpenAI,
        baseURL: "https://example.com/internal-gateway/v1",
      }),
    ).toBe(CUSTOM_PRESET_ID);

    // No stored base URL means the SDK default, which is the OpenAI preset
    expect(
      inferLlmProviderPresetId({
        adapter: LLMAdapter.OpenAI,
        baseURL: null,
      }),
    ).toBe("openai");
  });
});
