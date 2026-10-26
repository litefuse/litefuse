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

  it("has unique (adapter, baseURL, models) so presets stay distinguishable", () => {
    // One gateway can carry several models (OpenRouter serves both Liquid AI d1
    // and Microsoft-Decision-1), so the model list is part of the identity.
    const keys = llmProviderPresets.map(
      (preset) =>
        `${preset.adapter}|${preset.baseURL.replace(/\/+$/, "")}|${preset.customModels.join(",")}`,
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
        // Only the native adapters may rely on the SDK default base URL.
        // LLMAdapter.TypeSafe is the exception: an empty base URL means "the
        // TypeSafe endpoint itself" (the decision-model client defaults to
        // https://api.typesafe.ai/v1) and the form renders the upstream picker
        // instead of a base URL field. See TYPESAFE_UPSTREAMS in @langfuse/shared.
        expect([
          LLMAdapter.OpenAI,
          LLMAdapter.Anthropic,
          LLMAdapter.GoogleAIStudio,
          LLMAdapter.TypeSafe,
        ]).toContain(preset.adapter);
        continue;
      }

      const parsed = new URL(preset.baseURL);
      expect(["http:", "https:"]).toContain(parsed.protocol);
    }
  });

  it("offers a decision-model (Jev) preset for the TypeSafe adapter", () => {
    const preset = llmProviderPresets.find(
      (p) => p.adapter === LLMAdapter.TypeSafe,
    );

    expect(preset).toBeDefined();
    // Empty base URL = the direct TypeSafe upstream; see TYPESAFE_UPSTREAMS[0].
    expect(preset!.baseURL).toBe("");
    expect(preset!.label.toLowerCase()).toContain("decision model");
    // Converged with upstream main, which dropped `jev-1.13.0` from
    // `typeSafeModels` in favour of the `jev-latest` alias.
    expect(preset!.customModels).toEqual(["jev-latest"]);
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

  it("offers a dedicated decision-model group with one entry per supported vendor", () => {
    const group = groupLlmProviderPresets().find(
      (candidate) => candidate.group === "decision-model",
    );

    expect(group).toBeDefined();
    expect(group!.label).toBe("Decision models");
    expect(group!.presets.map((preset) => preset.id).sort()).toEqual([
      "alibaba-bailian-decision",
      "cloudflare-clef",
      "inception-mercury-decide",
      "liquid-d1",
      "liquid-d1-openrouter",
      "microsoft-decision-1-azure",
      "microsoft-decision-1-openrouter",
      "openai-decision-model",
      "openrouter-decision-models",
      "perplexity-decider",
      "typesafe-decision-model",
      "upstage-solar-decide",
    ]);

    // Every entry must use a decision-model adapter. TypeSafe covers the
    // System One gateways; OpenAI is the hosted Decisions API.
    for (const preset of group!.presets) {
      expect([LLMAdapter.TypeSafe, LLMAdapter.OpenAI]).toContain(
        preset.adapter,
      );
      expect(preset.customModels.length).toBeGreaterThan(0);
    }
  });

  it("carries a vendor-native channel next to the OpenRouter routes", () => {
    const byId = new Map(
      llmProviderPresets.map((preset) => [preset.id, preset] as const),
    );

    // Every vendor we verified through OpenRouter also gets its own connection,
    // so a user with a vendor key does not need OpenRouter.
    expect(byId.get("perplexity-decider")?.baseURL).toBe(
      "https://api.perplexity.ai/v1",
    );
    expect(byId.get("upstage-solar-decide")?.baseURL).toBe(
      "https://api.upstage.ai/v1",
    );
    expect(byId.get("liquid-d1")?.baseURL).toBe("https://api.liquid.ai/v1");
    expect(byId.get("inception-mercury-decide")?.baseURL).toBe(
      "https://api.inceptionlabs.ai/v1",
    );
    // Account-scoped hosts stay empty so the form asks for them.
    expect(byId.get("cloudflare-clef")?.baseURL).toBe("");
    expect(byId.get("cloudflare-clef")?.customModels).toEqual([
      "clef",
      "clef-flash",
    ]);
    // The vendor presets point at the decision-model adapter, not a gateway.
    for (const id of [
      "openai-decision-model",
      "perplexity-decider",
      "upstage-solar-decide",
      "liquid-d1",
      "inception-mercury-decide",
      "cloudflare-clef",
    ]) {
      const preset = byId.get(id);
      expect([LLMAdapter.TypeSafe, LLMAdapter.OpenAI]).toContain(
        preset?.adapter,
      );
      if (preset?.adapter === LLMAdapter.TypeSafe) {
        expect(preset.typeSafeUpstream).toBe("custom");
      }
    }
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

  it("infers a preset whose adapter and base URL match the stored connection", () => {
    // Two presets can share a base URL (Liquid AI d1 and Microsoft-Decision-1
    // both ride OpenRouter), so inference only promises a matching endpoint,
    // not a specific model.
    const normalize = (value: string) => value.replace(/\/+$/, "");
    const normalizeId = (id: string) => {
      const preset = getLlmProviderPreset(id);
      return `${preset!.adapter}|${normalize(preset!.baseURL)}`;
    };

    for (const preset of llmProviderPresets) {
      const expected = `${preset.adapter}|${normalize(preset.baseURL)}`;

      expect(
        normalizeId(
          inferLlmProviderPresetId({
            adapter: preset.adapter,
            baseURL: preset.baseURL,
          }),
        ),
      ).toBe(expected);

      // Stored base URLs may have a trailing slash
      if (preset.baseURL !== "") {
        expect(
          normalizeId(
            inferLlmProviderPresetId({
              adapter: preset.adapter,
              baseURL: `${preset.baseURL}/`,
            }),
          ),
        ).toBe(expected);
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
