// ── LITEFUSE ADDITION: OpenAI Decisions API client ──────────────────────────
// OpenAI's decision endpoint is *not* System One: the wire format differs in
// almost every field, which is why it needs its own client instead of the
// TypeSafe one. Measured against the Decisions API reference and guide
// (public beta, model `gpt-6-luna`):
//
//   POST {baseURL}/decisions
//   Authorization: Bearer <apiKey>
//   {
//     model: "gpt-6-luna",
//     input: "<flattened state>",            // string, or message parts array
//     questions: [                           // ARRAY, not a keyed object
//       { type: "predicate", name, instructions },
//       { type: "choice", name, instructions, choices: [{ value, description }] },
//       { type: "score",  name, instructions, levels:  [{ label, description }] }
//     ]
//   }
//   → {
//       model,
//       answers: [                           // same order as the questions
//         { type: "predicate", name, probability },
//         { type: "choice", name, choice, probabilities: [{ value, probability }], confidence },
//         { type: "score",  name, score, probabilities: [{ value, probability }] }
//       ],
//       usage: { input_tokens, output_tokens }
//     }
//
// Differences from System One that this module absorbs:
//   * boolean → "predicate"; criteria map → choices/levels arrays;
//   * questions/answers are ordered arrays, so answers are re-keyed by `name`
//     (falling back to position when a name is omitted);
//   * probabilities come back as `[{ value, probability }]`, not a map.
//
// Proxy: same `HTTPS_PROXY` → undici `ProxyAgent` handling as the TypeSafe
// client, because api.openai.com is commonly the endpoint that needs the proxy.
// ────────────────────────────────────────────────────────────────────────────

import { z } from "zod/v4";
import type { Dispatcher } from "undici";
import { LLMCompletionError } from "../../llm/errors";

import { decisionModelProxyDispatcher } from "../proxyDispatcher";
import type {
  DecisionModelAnswer,
  DecisionModelClient,
  DecisionModelEvaluation,
  DecisionModelRequest,
  DecisionModelRequestQuestion,
} from "../../evals/decisionModelEvaluatorExecution";
import type { DecisionModelEntry } from "../../../features/evals/decisionModel";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DECISIONS_PATH = "/decisions";
const USER_AGENT = "litefuse-evaluator/1";

/** Probability pairs are `[{ value, probability }]`; tolerate a plain map too. */
const probabilityPairSchema = z.object({
  value: z.union([z.string(), z.number()]),
  probability: z.number(),
});

const openAiAnswerSchema = z.union([
  z.object({
    type: z.literal("predicate"),
    name: z.string().nullish(),
    probability: z.number(),
  }),
  z.object({
    type: z.literal("choice"),
    name: z.string().nullish(),
    choice: z.string(),
    probabilities: z
      .union([z.array(probabilityPairSchema), z.record(z.string(), z.number())])
      .nullish(),
    confidence: z.number().nullish(),
  }),
  z.object({
    type: z.literal("score"),
    name: z.string().nullish(),
    score: z.number(),
    probabilities: z
      .union([z.array(probabilityPairSchema), z.record(z.string(), z.number())])
      .nullish(),
    confidence: z.number().nullish(),
  }),
]);

const openAiResponseSchema = z.object({
  model: z.string().nullish(),
  answers: z.array(openAiAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
    })
    .nullish(),
});

/** Question text is free-form in our domain model; flatten it to a string. */
function toDecisionText(entry: DecisionModelEntry): string {
  return typeof entry === "string" ? entry : JSON.stringify(entry);
}

/** The state object is sent as one text input, same flattening as System One. */
export function toOpenAiInput(state: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(state)) {
    if (value === null || value === undefined) continue;
    parts.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  return parts.join("\n\n");
}

type OpenAiQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | {
      type: "choice";
      name: string;
      instructions: string;
      choices: Array<{ value: string; description: string }>;
    }
  | {
      type: "score";
      name: string;
      instructions: string;
      levels: Array<{ label: string; description: string }>;
    };

/** Our three domain question types → OpenAI's ordered question array. */
export function toOpenAiQuestions(
  questions: Record<string, DecisionModelRequestQuestion>,
): OpenAiQuestion[] {
  return Object.entries(questions).map(([name, question]) => {
    const instructions = toDecisionText(question.instructions);
    switch (question.type) {
      case "boolean":
        return { type: "predicate", name, instructions };
      case "choice":
        return {
          type: "choice",
          name,
          instructions,
          choices: Object.entries(question.criteria).map(
            ([value, description]) => ({
              value,
              description: description == null ? "" : toDecisionText(description),
            }),
          ),
        };
      case "score":
        return {
          type: "score",
          name,
          instructions,
          levels: question.criteria.map((description, index) => ({
            label: index.toString(),
            description:
              description == null ? `level ${index}` : toDecisionText(description),
          })),
        };
    }
  });
}

function toProbabilityMap(
  value:
    | Array<{ value: string | number; probability: number }>
    | Record<string, number>
    | null
    | undefined,
): Record<string, number> {
  if (!value) return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((pair) => [String(pair.value), pair.probability]));
  }
  return value;
}

function toAnswer(
  answer: z.infer<typeof openAiAnswerSchema>,
): DecisionModelAnswer {
  switch (answer.type) {
    case "predicate":
      return { type: "boolean", probability: answer.probability };
    case "choice":
      return {
        type: "choice",
        choice: answer.choice,
        probabilities: toProbabilityMap(answer.probabilities),
        confidence: answer.confidence ?? null,
      };
    case "score":
      return {
        type: "score",
        score: answer.score,
        probabilities: toProbabilityMap(answer.probabilities),
        confidence: answer.confidence ?? null,
      };
  }
}

function withoutTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function createOpenAiDecisionModelClient(params: {
  apiKey: string;
  model: string;
  baseURL?: string | null;
  fetchImpl?: typeof fetch;
}): DecisionModelClient {
  const baseURL = withoutTrailingSlash(params.baseURL ?? OPENAI_DEFAULT_BASE_URL);
  const doFetch = params.fetchImpl ?? fetch;
  const proxyDispatcher: Dispatcher | undefined =
    decisionModelProxyDispatcher(baseURL);

  return {
    evaluate: async (
      request: DecisionModelRequest,
    ): Promise<DecisionModelEvaluation> => {
      const questionIds = Object.keys(request.questions);
      const init: RequestInit & { dispatcher?: Dispatcher } = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          model: params.model,
          input: toOpenAiInput(request.state),
          questions: toOpenAiQuestions(request.questions),
        }),
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      };

      const response = await doFetch(`${baseURL}${DECISIONS_PATH}`, init);

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // LLMCompletionError so the eval queue shows the provider's own message
        // (see the same block in the TypeSafe client).
        throw new LLMCompletionError({
          message: `Decision model request failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
          responseStatusCode: response.status,
          isRetryable: response.status === 429 || response.status >= 500,
        });
      }

      const parsed = openAiResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error(
          `Decision model returned an unexpected response: ${parsed.error.message}`,
        );
      }

      const answers: Record<string, DecisionModelAnswer> = {};
      parsed.data.answers.forEach((answer, index) => {
        const fallbackId = questionIds[index];
        const id = answer.name ?? fallbackId;
        if (id === undefined) return;
        answers[id] = toAnswer(answer);
      });

      return {
        model: parsed.data.model ?? params.model,
        answers,
        usage: parsed.data.usage
          ? {
              inputTokens: parsed.data.usage.input_tokens ?? null,
              outputTokens: parsed.data.usage.output_tokens ?? null,
            }
          : null,
      };
    },
  };
}
