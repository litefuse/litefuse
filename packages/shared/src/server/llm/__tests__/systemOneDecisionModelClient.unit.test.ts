import { describe, expect, it } from "vitest";

import {
  createTypeSafeDecisionModelClient,
  decisionModelAuthMode,
  decisionModelProfile,
  decisionModelWirePath,
  toWireState,
  unsupportedDecisionQuestionTypes,
} from "../typesafe/typeSafeDecisionModelClient";

type Captured = { url: string; init: RequestInit };

function fakeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function capture(body: unknown, status = 200) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return fakeResponse(body, status);
  }) as unknown as typeof fetch;
  return { captured, fetchImpl };
}

const request = {
  state: { message: "hello" },
  questions: {
    kind: {
      type: "choice" as const,
      instructions: "Which one?",
      criteria: { a: null, b: null },
    },
    ok: { type: "boolean" as const, instructions: "Is it fine?" },
    severity: {
      type: "score" as const,
      instructions: "How bad?",
      criteria: ["low", "high"],
    },
  },
};

const answers = {
  model: "some-model",
  answers: {
    kind: {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.9,
    },
    ok: { type: "noul", noul: 0.93 },
    severity: {
      type: "score",
      score: 1.4,
      probabilities: { "0": 0.6, "1": 0.4 },
    },
  },
  usage: { input_tokens: 12 },
};

describe("System One decision-model client", () => {
  it("posts the System One body to {baseURL}/systemone with Bearer by default", async () => {
    const { captured, fetchImpl } = capture(answers);
    const client = createTypeSafeDecisionModelClient({
      apiKey: "secret",
      model: "jev-latest",
      baseURL: null,
      fetchImpl,
    });

    await client.evaluate(request);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["api-key"]).toBeUndefined();

    const body = JSON.parse(String(captured[0]!.init.body));
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({ message: "hello" });
    // Boolean questions travel as `noul`, everything else passes through.
    expect(body.questions.ok.type).toBe("noul");
    expect(body.questions.kind).toEqual({
      type: "choice",
      instructions: "Which one?",
      criteria: { a: null, b: null },
    });
  });

  it("answers with the domain shape", async () => {
    const { fetchImpl } = capture(answers);
    const client = createTypeSafeDecisionModelClient({
      apiKey: "secret",
      model: "jev-latest",
      fetchImpl,
    });

    const result = await client.evaluate(request);

    expect(result.model).toBe("some-model");
    expect(result.answers.kind).toEqual({
      type: "choice",
      choice: "a",
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.9,
    });
    expect(result.answers.ok).toEqual({ type: "boolean", probability: 0.93 });
    expect(result.answers.severity).toMatchObject({
      type: "score",
      score: 1.4,
    });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: null });
  });

  it("uses the api-key header on Azure Foundry endpoints", async () => {
    const { captured, fetchImpl } = capture(answers);
    const client = createTypeSafeDecisionModelClient({
      apiKey: "azure-key",
      model: "my-decision-deployment",
      baseURL: "https://res.cognitiveservices.azure.com/providers/microsoft/v1",
      fetchImpl,
    });

    await client.evaluate(request);

    expect(captured[0]!.url).toBe(
      "https://res.cognitiveservices.azure.com/providers/microsoft/v1/systemone",
    );
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("azure-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("parses the Alibaba Bailian answer shape (noul + input-only usage)", async () => {
    const { captured, fetchImpl } = capture({
      model: "decision-model-preview",
      request_id: "req-1",
      answers: {
        ok: { type: "noul", noul: 0.99 },
      },
      usage: { input_tokens: 125 },
      latency_ms: 52.9,
    });

    const client = createTypeSafeDecisionModelClient({
      apiKey: "dashscope-key",
      model: "decision-model-preview",
      baseURL: "https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      fetchImpl,
    });

    const result = await client.evaluate({
      // The domain state is always an object; the provider accepts either, and
      // Alibaba's docs show a bare string, so the object is serialised verbatim.
      state: { text: "ticket text" },
      questions: { ok: { type: "boolean", instructions: "Refund?" } },
    });

    expect(captured[0]!.url).toBe(
      "https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
    );
    expect(result.answers.ok).toEqual({ type: "boolean", probability: 0.99 });
    expect(result.usage).toEqual({ inputTokens: 125, outputTokens: null });
  });

  it("accepts the probability alias some gateways return for noul", async () => {
    const { fetchImpl } = capture({
      answers: { ok: { type: "noul", probability: 0.42 } },
    });

    const client = createTypeSafeDecisionModelClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
    });

    await expect(client.evaluate(request)).resolves.toMatchObject({
      answers: { ok: { type: "boolean", probability: 0.42 } },
    });
  });

  it("surfaces the provider status and body on failure", async () => {
    const { fetchImpl } = capture(
      { error: { message: "deployment not found" } },
      422,
    );

    const client = createTypeSafeDecisionModelClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
    });

    await expect(client.evaluate(request)).rejects.toThrow(
      /Decision model request failed \(422\).*deployment not found/,
    );
  });

  it("classifies the auth header from the endpoint", () => {
    expect(decisionModelAuthMode(null)).toBe("bearer");
    expect(decisionModelAuthMode("https://api.typesafe.ai/v1")).toBe("bearer");
    expect(decisionModelAuthMode("https://openrouter.ai/api/v1")).toBe(
      "bearer",
    );
    expect(
      decisionModelAuthMode(
        "https://res.cognitiveservices.azure.com/providers/microsoft/v1",
      ),
    ).toBe("api-key");
    expect(
      decisionModelAuthMode(
        "https://res.services.ai.azure.com/providers/microsoft/v1",
      ),
    ).toBe("api-key");
    expect(decisionModelAuthMode("not a url")).toBe("bearer");
  });
});

describe("decision-model wire path", () => {
  it("defaults to /systemone", () => {
    expect(
      decisionModelWirePath("https://api.typesafe.ai/v1", "jev-latest"),
    ).toBe("/systemone");
    expect(
      decisionModelWirePath("https://openrouter.ai/api/v1", "liquid/d1"),
    ).toBe("/systemone");
  });

  it("uses /decisions for Perplexity and OpenAI", () => {
    expect(
      decisionModelWirePath(
        "https://api.perplexity.ai/v1",
        "pplx-decider-v1.2",
      ),
    ).toBe("/decisions");
    // A host-only base URL still reaches the documented path.
    expect(
      decisionModelWirePath("https://api.perplexity.ai", "pplx-decider-v1.2"),
    ).toBe("/v1/decisions");
    expect(
      decisionModelWirePath("https://api.openai.com/v1", "gpt-6-luna"),
    ).toBe("/decisions");
  });

  it("keeps a base URL that already names the path", () => {
    expect(
      decisionModelWirePath(
        "https://api.typesafe.ai/v1/systemone",
        "jev-latest",
      ),
    ).toBe("");
    expect(
      decisionModelWirePath("https://api.perplexity.ai/v1/decisions/", "x"),
    ).toBe("");
  });

  it("posts Perplexity to {baseURL}/decisions", async () => {
    const { captured, fetchImpl } = capture(answers);
    const client = createTypeSafeDecisionModelClient({
      apiKey: "pk",
      baseURL: "https://api.perplexity.ai/v1",
      model: "pplx-decider-v1.2",
      fetchImpl,
    });
    await client.evaluate(request);
    expect(captured[0]?.url).toBe("https://api.perplexity.ai/v1/decisions");
  });
});

describe("System One per-provider wire differences", () => {
  const state = { input: "Q: capital of France?", output: "A: Paris." };

  it("sends the flat state by default", () => {
    expect(decisionModelProfile("typesafe/jev-1.14").stateShape).toBe("flat");
    expect(toWireState("typesafe/jev-1.14", state)).toEqual(state);
    expect(toWireState("liquid/d1-ultra", state)).toEqual(state);
  });

  it("collapses the state to `text` for ScaleDown", () => {
    expect(decisionModelProfile("scaledown/classify-1").stateShape).toBe(
      "text",
    );
    expect(toWireState("scaledown/classify-1", state)).toEqual({
      text: "Q: capital of France?\n\nA: Paris.",
    });
  });

  it("builds a chat transcript for Respan span-01", () => {
    expect(decisionModelProfile("respan/span-01-lite").stateShape).toBe(
      "messages",
    );
    expect(toWireState("respan/span-01-lite", state)).toEqual({
      input: [{ role: "user", content: "Q: capital of France?" }],
      output: { role: "assistant", content: "A: Paris." },
    });
  });

  it("keeps the flat state for Respan span-02", () => {
    expect(decisionModelProfile("respan/span-02").stateShape).toBe("flat");
    expect(toWireState("respan/span-02", state)).toEqual(state);
  });

  it("reports the question types a model cannot answer", () => {
    // Respan span-01 is noul-only; choice/score would be rejected by the
    // provider, so the validator refuses them up front.
    expect(
      unsupportedDecisionQuestionTypes("respan/span-01", [
        "choice",
        "score",
        "boolean",
      ]),
    ).toEqual(["choice", "score"]);
    expect(
      unsupportedDecisionQuestionTypes("respan/span-01", ["boolean"]),
    ).toEqual([]);
    expect(
      unsupportedDecisionQuestionTypes("scaledown/classify-1", [
        "choice",
        "score",
        "boolean",
      ]),
    ).toEqual([]);
  });
});
