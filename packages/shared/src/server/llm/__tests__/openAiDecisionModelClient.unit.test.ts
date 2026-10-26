import { describe, expect, it } from "vitest";

import {
  createOpenAiDecisionModelClient,
  toOpenAiInput,
  toOpenAiQuestions,
} from "../openai/openAiDecisionModelClient";
import { createDecisionModelClient } from "../createDecisionModelClient";
import { LLMAdapter } from "../types";

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
  state: { input: "The invoice total is wrong", output: "It is €120" },
  questions: {
    urgent: { type: "boolean" as const, instructions: "Is this urgent?" },
    route: {
      type: "choice" as const,
      instructions: "Which team?",
      criteria: { billing: "Charges and refunds", technical: null },
    },
    severity: {
      type: "score" as const,
      instructions: "How bad?",
      criteria: ["low", "medium", "high"],
    },
  },
};

const answers = {
  model: "gpt-6-luna",
  answers: [
    { type: "predicate", name: "urgent", probability: 0.87 },
    {
      type: "choice",
      name: "route",
      choice: "billing",
      probabilities: [
        { value: "billing", probability: 0.9 },
        { value: "technical", probability: 0.1 },
      ],
      confidence: 0.8,
    },
    {
      type: "score",
      name: "severity",
      score: 1.6,
      probabilities: [
        { value: "0", probability: 0.1 },
        { value: "1", probability: 0.2 },
        { value: "2", probability: 0.7 },
      ],
    },
  ],
  usage: { input_tokens: 42, output_tokens: 0 },
};

describe("OpenAI decision-model client", () => {
  it("posts the array-shaped Decisons body to /v1/decisions with Bearer auth", async () => {
    const { captured, fetchImpl } = capture(answers);
    const client = createOpenAiDecisionModelClient({
      apiKey: "sk-openai",
      model: "gpt-6-luna",
      fetchImpl,
    });

    await client.evaluate(request);

    expect(captured[0]?.url).toBe("https://api.openai.com/v1/decisions");
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-openai");

    const body = JSON.parse(String(captured[0]?.init.body));
    expect(body.model).toBe("gpt-6-luna");
    // State is flattened to one text input, not sent as an object.
    expect(typeof body.input).toBe("string");
    expect(body.input).toContain("The invoice total is wrong");
    // Questions are an ordered array, not a keyed object.
    expect(Array.isArray(body.questions)).toBe(true);
    expect(body.questions.map((q: { name: string }) => q.name)).toEqual([
      "urgent",
      "route",
      "severity",
    ]);
    expect(body.questions[0]).toEqual({
      type: "predicate",
      name: "urgent",
      instructions: "Is this urgent?",
    });
    expect(body.questions[1].type).toBe("choice");
    expect(body.questions[1].choices).toEqual([
      { value: "billing", description: "Charges and refunds" },
      { value: "technical", description: "" },
    ]);
    expect(body.questions[2].type).toBe("score");
    expect(body.questions[2].levels).toEqual([
      { label: "0", description: "low" },
      { label: "1", description: "medium" },
      { label: "2", description: "high" },
    ]);
  });

  it("maps the array answers back onto the domain shape, keyed by name", async () => {
    const { fetchImpl } = capture(answers);
    const client = createOpenAiDecisionModelClient({
      apiKey: "sk-openai",
      model: "gpt-6-luna",
      fetchImpl,
    });

    const evaluation = await client.evaluate(request);

    expect(evaluation.model).toBe("gpt-6-luna");
    expect(evaluation.answers.urgent).toEqual({
      type: "boolean",
      probability: 0.87,
    });
    expect(evaluation.answers.route).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.8,
    });
    expect(evaluation.answers.severity).toEqual({
      type: "score",
      score: 1.6,
      probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
      confidence: null,
    });
    expect(evaluation.usage).toEqual({ inputTokens: 42, outputTokens: 0 });
  });

  it("falls back to question order when the provider omits names", async () => {
    const { fetchImpl } = capture({
      model: "gpt-6-luna",
      answers: [
        { type: "predicate", probability: 0.5 },
        { type: "choice", choice: "technical", probabilities: [] },
      ],
    });
    const client = createOpenAiDecisionModelClient({
      apiKey: "sk-openai",
      model: "gpt-6-luna",
      fetchImpl,
    });

    const evaluation = await client.evaluate(request);

    expect(evaluation.answers.urgent).toEqual({
      type: "boolean",
      probability: 0.5,
    });
    expect(evaluation.answers.route?.type).toBe("choice");
  });

  it("keeps a map-shaped probabilities payload working", async () => {
    const { fetchImpl } = capture({
      model: "gpt-6-luna",
      answers: [
        {
          type: "choice",
          name: "route",
          choice: "billing",
          probabilities: { billing: 1 },
        },
      ],
    });
    const client = createOpenAiDecisionModelClient({
      apiKey: "sk-openai",
      model: "gpt-6-luna",
      fetchImpl,
    });

    const evaluation = await client.evaluate(request);

    expect(evaluation.answers.route).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 1 },
      confidence: null,
    });
  });

  it("treats 429 and 5xx as retryable", async () => {
    for (const status of [429, 503]) {
      const { fetchImpl } = capture({ error: "busy" }, status);
      const client = createOpenAiDecisionModelClient({
        apiKey: "sk-openai",
        model: "gpt-6-luna",
        fetchImpl,
      });
      await expect(client.evaluate(request)).rejects.toMatchObject({
        name: "LLMCompletionError",
        isRetryable: true,
      });
    }
  });

  it("surfaces a 400 as a non-retryable LLM error carrying the provider body", async () => {
    const { fetchImpl } = capture({ error: "unknown model" }, 400);
    const client = createOpenAiDecisionModelClient({
      apiKey: "sk-openai",
      model: "gpt-6-luna",
      fetchImpl,
    });
    await expect(client.evaluate(request)).rejects.toMatchObject({
      name: "LLMCompletionError",
      isRetryable: false,
    });
    await expect(client.evaluate(request)).rejects.toThrow(
      /Decision model request failed \(400\).*unknown model/s,
    );
  });

  it("rejects an unexpected payload shape", async () => {
    const { fetchImpl } = capture({ answers: "nope" });
    const client = createOpenAiDecisionModelClient({
      apiKey: "sk-openai",
      model: "gpt-6-luna",
      fetchImpl,
    });
    await expect(client.evaluate(request)).rejects.toThrow(
      /unexpected response/,
    );
  });
});

describe("decision-model client factory", () => {
  it("dispatches by adapter", async () => {
    const typesafe = capture(answers);
    const openai = capture(answers);

    createDecisionModelClient({
      adapter: LLMAdapter.TypeSafe,
      apiKey: "k",
      model: "jev-latest",
      baseURL: "https://api.typesafe.ai/v1",
      fetchImpl: typesafe.fetchImpl,
    });
    // Construction alone must not call the provider.
    expect(typesafe.captured).toHaveLength(0);

    const client = createDecisionModelClient({
      adapter: LLMAdapter.OpenAI,
      apiKey: "k",
      model: "gpt-6-luna",
      fetchImpl: openai.fetchImpl,
    });
    await client.evaluate(request);
    expect(openai.captured[0]?.url).toBe("https://api.openai.com/v1/decisions");
  });

  it("refuses an adapter that cannot answer decision models", () => {
    expect(() =>
      createDecisionModelClient({
        adapter: LLMAdapter.Anthropic,
        apiKey: "k",
        model: "claude",
      }),
    ).toThrow(/cannot answer decision-model evaluators/);
  });
});

describe("OpenAI prompt mapping helpers", () => {
  it("flattens state values into one input string", () => {
    expect(toOpenAiInput({ a: "x", b: 1, c: null })).toBe("x\n\n1");
  });

  it("turns a boolean question into a predicate", () => {
    expect(
      toOpenAiQuestions({
        ok: { type: "boolean", instructions: "Is it fine?" },
      }),
    ).toEqual([{ type: "predicate", name: "ok", instructions: "Is it fine?" }]);
  });
});
