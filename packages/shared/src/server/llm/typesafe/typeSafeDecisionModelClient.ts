// ── LITEFUSE NOTE (authored; wire-compatible replacement) ───────────────────
// Upstream builds this client on `@ai-sdk/typesafe-ai` + `experimental_evaluate`
// from `ai@7`. Decision U1 does not adopt the AI SDK, so this hand-writes the same
// call.
//
// It is wire-compatible on purpose: the request path, headers, body and response
// shape were read from the installed `@ai-sdk/typesafe-ai@3.0.16` dist
// (`dist/index.js`, `DecisionTypeSafeAiModel.doDecide`), so a Jev endpoint that
// upstream can talk to works unchanged:
//
//   POST {baseURL}/systemone
//   Authorization: Bearer <apiKey>
//   { model, state, questions }            // boolean questions are sent as "noul"
//   → { model, answers: { id: answer }, usage: { input_tokens, output_tokens } }
//
// Upstream's 95-line client only delegates one call (`evaluate`) to the SDK; the
// rest of it — answer translation, confidence clean-up — is written out here too,
// because that part has to exist either way.
//
// Proxy support (LITEFUSE ADDITION): a raw `fetch` ignores the HTTP(S)_PROXY
// environment variables, so a Jev endpoint that is only reachable through a proxy
// (e.g. a region-restricted provider behind a VPN, or a corporate gateway) would
// otherwise be unreachable. This mirrors what `fetchLLMCompletion` already does for
// the LLM-judge path: build an undici `ProxyAgent` from `HTTPS_PROXY` and hand it to
// fetch as the dispatcher. Note undici's ProxyAgent speaks HTTP(S) proxies only —
// a SOCKS5-only proxy needs a bridge or a SOCKS-capable agent.
//
// Deviation: upstream wraps fetch in `createSecureLlmFetch` (SSRF hardening for a
// user-supplied base URL). We do not have that module, and no other LLM call in
// this project validates the connection's base URL either, so this uses plain
// `fetch` and stays consistent. Hardening suggestion: reuse the guards in
// `server/webhooks/ipBlocking.ts` for both this and `fetchLLMCompletion`.
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

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
/**
 * System One endpoints live at `/systemone` on every gateway we support, but
 * Perplexity (and OpenAI's own decision endpoint) publish the same request and
 * response schema at `/decisions`. A connection that already names the full
 * path is sent as-is.
 */
const SYSTEM_ONE_PATH = "/systemone";
const DECISIONS_PATH = "/decisions";
const USER_AGENT = "litefuse-evaluator/1";

/** Mirrors the provider's response schema (see the file header). */
const decisionResponseSchema = z.object({
  model: z.string().nullish(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        probabilities: z.record(z.string(), z.number()),
        confidence: z.number().nullish(),
      }),
      z.object({
        type: z.literal("score"),
        score: z.number(),
        probabilities: z.record(z.string(), z.number()),
        confidence: z.number().nullish(),
      }),
      z
        .object({
          type: z.literal("noul"),
          // System One implementations disagree on the key: TypeSafe, Alibaba
          // and vLLM return `noul`, some gateways normalise it to
          // `probability`. Accept either.
          noul: z.number().nullish(),
          probability: z.number().nullish(),
        })
        .refine(
          (answer) =>
            typeof answer.noul === "number" ||
            typeof answer.probability === "number",
          { message: "A noul answer must carry a probability" },
        ),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
    })
    .nullish(),
});

/**
 * System One hosts do not agree on the auth header. TypeSafe, Alibaba, vLLM and
 * the gateways take `Authorization: Bearer <key>`; Azure Foundry's decision
 * endpoint takes `api-key: <key>` (its Bearer form is an Entra ID token, which a
 * stored API key is not).
 *
 * Detected from the endpoint instead of adding a schema field: the base URL
 * already identifies the host family, and this keeps existing connections and
 * the connection form unchanged.
 */
/**
 * Per-model wire differences measured against OpenRouter's 27 decision models
 * (see `decision-model-e2e.mjs`). Everything unspecified uses the flat
 * `{variable: value}` state and all three question types, which is what 21 of
 * those models accept unchanged.
 */
type DecisionModelProfile = {
  /** `flat` = the state object as built from the variable mapping. */
  stateShape: "flat" | "text" | "messages";
  /** Question types the provider accepts. `boolean` maps to wire `noul`. */
  questionTypes: ReadonlyArray<"choice" | "score" | "boolean">;
};

const ALL_QUESTION_TYPES = ["choice", "score", "boolean"] as const;

export function decisionModelProfile(model: string): DecisionModelProfile {
  const id = model.toLowerCase();
  // ScaleDown rejects a keyed state: it wants the text under `text` (a plain
  // string works too). Verified: all three question types pass.
  if (id.startsWith("scaledown/")) {
    return { stateShape: "text", questionTypes: ALL_QUESTION_TYPES };
  }
  // Respan's span-01 family takes a chat-shaped state and only answers noul.
  // span-02 (below) is the newer, fully capable one and accepts both shapes.
  if (/^respan\/span-01/.test(id)) {
    return { stateShape: "messages", questionTypes: ["boolean"] };
  }
  return { stateShape: "flat", questionTypes: ALL_QUESTION_TYPES };
}

/**
 * Question types the model cannot answer, so the validator can refuse to save a
 * decision model the provider would always reject (Respan span-01 takes noul
 * only).
 */
export function unsupportedDecisionQuestionTypes(
  model: string,
  requested: ReadonlyArray<"choice" | "score" | "boolean">,
): Array<"choice" | "score" | "boolean"> {
  const supported = decisionModelProfile(model).questionTypes;
  return requested.filter((type) => !supported.includes(type));
}

function flattenStateValues(state: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(state)) {
    if (value === null || value === undefined) continue;
    parts.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  return parts.join("\n\n");
}

/** Applies the provider's state shape to the state built from the mapping. */
export function toWireState(
  model: string,
  state: Record<string, unknown>,
): unknown {
  switch (decisionModelProfile(model).stateShape) {
    case "text":
      return { text: flattenStateValues(state) };
    case "messages": {
      const input = "input" in state ? state.input : flattenStateValues(state);
      const output = "output" in state ? state.output : "";
      return {
        input: [{ role: "user", content: String(input) }],
        output: { role: "assistant", content: String(output) },
      };
    }
    default:
      return state;
  }
}

/**
 * Path appended to the connection's base URL. Derived from the host so the
 * connection form keeps a single "API Base URL" field.
 */
export function decisionModelWirePath(
  baseURL: string | null | undefined,
  _model: string,
): string {
  const trimmed = withoutTrailingSlash(baseURL ?? DEFAULT_BASE_URL);
  if (trimmed.endsWith(SYSTEM_ONE_PATH) || trimmed.endsWith(DECISIONS_PATH)) {
    return "";
  }
  let host = "";
  let pathname = "";
  try {
    const url = new URL(trimmed);
    host = url.hostname.toLowerCase();
    pathname = url.pathname.replace(/\/+$/, "");
  } catch {
    return SYSTEM_ONE_PATH;
  }
  // Perplexity's Decisions API and OpenAI's /v1/decisions use the same wire
  // schema as System One under a different path. A base URL without a version
  // segment still gets the documented `/v1/decisions`.
  if (host === "api.perplexity.ai" || host === "api.openai.com") {
    return pathname === "" ? "/v1/decisions" : DECISIONS_PATH;
  }
  return SYSTEM_ONE_PATH;
}

export function decisionModelAuthMode(
  baseURL: string | null | undefined,
): "bearer" | "api-key" {
  if (!baseURL) return "bearer";
  let host = "";
  let path = "";
  try {
    const url = new URL(baseURL);
    host = url.hostname;
    path = url.pathname;
  } catch {
    // A malformed URL falls through to the default; the request surfaces the
    // real error.
    return "bearer";
  }

  const isAzure =
    path.includes("/providers/microsoft/") ||
    host.endsWith(".cognitiveservices.azure.com") ||
    host.endsWith(".services.ai.azure.com");

  return isAzure ? "api-key" : "bearer";
}

function withoutTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Boolean questions are sent as `noul`; everything else passes through. */
function toWireQuestion(question: DecisionModelRequestQuestion) {
  return question.type === "boolean"
    ? { ...question, type: "noul" as const }
    : question;
}

function toAnswer(
  answer: z.infer<typeof decisionResponseSchema>["answers"][string],
): DecisionModelAnswer {
  switch (answer.type) {
    case "noul":
      return {
        type: "boolean",
        probability: (answer.noul ?? answer.probability) as number,
      };
    case "choice":
      return {
        type: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence ?? null,
      };
    case "score":
      return {
        type: "score",
        score: answer.score,
        probabilities: answer.probabilities,
        confidence: answer.confidence ?? null,
      };
  }
}

export function createTypeSafeDecisionModelClient(params: {
  apiKey: string;
  model: string;
  baseURL?: string | null;
  fetchImpl?: typeof fetch;
}): DecisionModelClient {
  const baseURL = withoutTrailingSlash(params.baseURL ?? DEFAULT_BASE_URL);
  const authMode = decisionModelAuthMode(params.baseURL);
  const doFetch = params.fetchImpl ?? fetch;
  // HTTPS_PROXY is the same variable the LLM-judge path honours, so one setting
  // covers every outbound LLM call in the worker. Read per client (not at module
  // load) so a test or a one-off script can set it before constructing the client.
  // Loopback targets (self-hosted vLLM, test doubles) bypass the proxy.
  const proxyDispatcher: Dispatcher | undefined =
    decisionModelProxyDispatcher(baseURL);

  return {
    evaluate: async (
      request: DecisionModelRequest,
    ): Promise<DecisionModelEvaluation> => {
      // `dispatcher` is undici's fetch extension and is not part of RequestInit.
      const init: RequestInit & { dispatcher?: Dispatcher } = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authMode === "api-key"
            ? { "api-key": params.apiKey }
            : { Authorization: `Bearer ${params.apiKey}` }),
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          model: params.model,
          // The provider expects the state object itself (upstream's SDK wraps a
          // lone json part back into the same object before sending it), with
          // per-provider shapes applied (ScaleDown wants `text`, Respan's
          // span-01 a chat transcript).
          state: toWireState(params.model, request.state),
          questions: Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => [
              id,
              toWireQuestion(question),
            ]),
          ),
        }),
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      };
      const response = await doFetch(
        `${baseURL}${decisionModelWirePath(baseURL, params.model)}`,
        init,
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // Every non-2xx becomes an LLMCompletionError: the eval queue records its
        // message verbatim, so a user sees the provider's own reason (region
        // block, unknown model, ToS refusal) instead of "An internal error
        // occurred". 429/5xx stay retryable — measured on OpenRouter, a busy
        // decision model answers 429 transiently (nace-ai/drex-v1.5) and succeeds
        // on retry.
        throw new LLMCompletionError({
          message: `Decision model request failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
          responseStatusCode: response.status,
          isRetryable: response.status === 429 || response.status >= 500,
        });
      }

      const parsed = decisionResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error(
          `Decision model returned an unexpected response: ${parsed.error.message}`,
        );
      }

      return {
        model: parsed.data.model ?? params.model,
        answers: Object.fromEntries(
          Object.entries(parsed.data.answers).map(([id, answer]) => [
            id,
            toAnswer(answer),
          ]),
        ),
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
