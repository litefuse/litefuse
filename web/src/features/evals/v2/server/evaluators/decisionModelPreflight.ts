// ── LITEFUSE ADDITION: decision-model save preflight ───────────────────────
// Upstream validates LLM-as-a-judge evaluators by *making the call* and letting
// the provider falsify the model name, instead of keeping a list of allowed
// models (a list we would have to maintain forever):
//
//   * upstream `web/src/features/evals/server/evaluator-preflight.ts:101-134`
//     (`getEvaluatorDefinitionPreflightError` → `testModelCall`, then
//     `llmError?.statusCode === 404` → "The provider could not find model '<m>'
//     — it may be retired, misspelled, or not available to your API key.")
//   * upstream `web/src/features/evals/v2/server/evaluators/evaluatorValidation.ts:171-199`
//     calls it with `{ throwOnOperationalError: true }` and turns the failure
//     into an `EvaluatorModelConfigurationError`.
//
// Upstream has no decision-model equivalent — decision-model evaluators are only
// checked against `isAllowedDecisionModel` there. Litefuse decision-model
// evaluators are built on TypeSafe/Jev connections where the model name is free
// text, so a typo used to be accepted at save time and only blew up on the first
// real run. This module adds the upstream-shaped capability for that side.
//
// ── Cost (read before changing the call conditions) ────────────────────────
// The probe below is a REAL provider call: one Jev request, i.e. one unit of
// the real Jev quota, per save. That is why `runDecisionModelPreflight` refuses
// to call at all unless the caller asks for it — see
// `isDecisionModelPreflightRequired`: on update, an unchanged provider+model
// pair skips the probe (renaming an evaluator, editing its questions or
// description must not spend quota).
//
// ── Intentional deviation from upstream ────────────────────────────────────
// Upstream blocks the save for *every* failure: a retryable provider error or a
// timeout becomes "The evaluator was not saved. Retry or check your LLM
// connection" (upstream evaluatorValidation.ts:186-199). We do not: if the
// failure is operational/reachability-shaped (transport error, proxy
// unavailable, timeout, 451 region block, 5xx, or any 4xx that is not a verdict
// about the model), the save is ALLOWED and the caller logs a warning. Blocking
// there would mean that a dropped VPN or a blocked region makes evaluators
// unsavable, which is a worse failure mode than saving an unverified model.
// Only a provider verdict about the model itself (404, or a body that names the
// model as unknown/invalid/not available) refuses the save.
//
// ── Why the status is captured by wrapping fetch ───────────────────────────
// `getLLMErrorInfo` (packages/shared/src/server/llm/errors.ts:133) only reads
// `LLMValidationError` / `LLMCompletionError`; our TypeSafe client is a
// hand-written `fetch` client that throws a plain `Error` with the HTTP status
// embedded in the message (packages/shared/src/server/llm/typesafe/
// typeSafeDecisionModelClient.ts:161-168). Rather than change that shared client
// we hand it a wrapped `fetch` that records the raw status/body, which keeps the
// classification exact and leaves the shared package untouched.
//
// Runtime imports are intentionally zero (types only): that keeps this module
// unit-testable with a stub client, without booting the shared server barrel or
// the DB. Client construction, config resolution and logging live in the caller
// (`evaluatorValidation.ts`).
// ───────────────────────────────────────────────────────────────────────────

import type {
  DecisionModelClient,
  DecisionModelRequest,
} from "@langfuse/shared/src/server";

export type DecisionModelPreflightModel = {
  provider: string;
  model: string;
};

/** What the wrapped `fetch` observed while the client made its call. */
export type DecisionModelProbeObservation = {
  /** HTTP status of the provider response, when one arrived. */
  status?: number;
  /** First bytes of a non-2xx body — the provider's own explanation. */
  body?: string;
  /** Set when `fetch` itself rejected (DNS, TLS, proxy, timeout, abort). */
  transportError?: unknown;
};

export type DecisionModelPreflightOutcome =
  /** The probe was not needed: the persisted version already uses this pair. */
  | { status: "skipped"; reason: "unchanged-provider-and-model" }
  /** The provider accepted the model. */
  | { status: "valid" }
  /**
   * The call failed in a way that says nothing about the model name. The caller
   * allows the save and logs this instead of refusing it.
   */
  | {
      status: "unverified";
      reason: string;
      detail: string;
      message: string;
    }
  /** The provider said the model is unusable → the caller must refuse the save. */
  | { status: "invalid"; message: string };

/**
 * The smallest request that still makes the provider resolve the model name: one
 * boolean question about a constant state. Deliberately NOT the evaluator's own
 * questions/state — at save time there is no observation to map them from, and
 * the only question this probe answers is "does this provider know this model?".
 */
export const DECISION_MODEL_PREFLIGHT_PROBE: DecisionModelRequest = {
  state: { litefuse_preflight: true },
  questions: {
    litefuse_preflight: {
      type: "boolean",
      instructions:
        "Answer true. This is a connectivity check, not an evaluation.",
    },
  },
};

/**
 * True when the probe would teach us something. On update, an unchanged
 * provider+model pair means the name was already accepted (or already refused)
 * for this evaluator version, so we skip the real call and its quota cost.
 * Called out separately so the skip is provable on its own (see the stub test).
 */
export function isDecisionModelPreflightRequired(params: {
  provider: string;
  model: string;
  previousModel?: DecisionModelPreflightModel | null;
}) {
  if (!params.previousModel) return true;
  return !(
    params.previousModel.provider === params.provider &&
    params.previousModel.model === params.model
  );
}

/**
 * Wraps the fetch the decision-model client uses, recording the provider's raw
 * verdict while staying transparent to the client (same response object, body
 * cloned so the client can still read it). It also imposes the client-initiated
 * timeout: without it a save request would wait on the provider indefinitely.
 */
export function createDecisionModelProbeFetch(params: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  observation: DecisionModelProbeObservation;
}): typeof fetch {
  const { fetchImpl, timeoutMs, observation } = params;

  return async (input, init) => {
    try {
      const response = await fetchImpl(input, {
        ...(init ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      observation.status = response.status;
      if (!response.ok) {
        observation.body = await response
          .clone()
          .text()
          .catch(() => "");
      }
      return response;
    } catch (error) {
      observation.transportError = error;
      throw error;
    }
  };
}

/**
 * Provider bodies that name the model itself as unusable. Kept as word-adjacency
 * patterns (not a bare "not found") so a 404-ish body about anything else — a
 * bad route, a malformed state — is not misread as a model verdict.
 */
const MODEL_VERDICT_PATTERNS: RegExp[] = [
  /\b(unknown|invalid|unsupported|unrecognized|unrecognised|no such|not found|missing|does not exist|doesn't exist|not available|retired|deprecated)\b[^.]{0,48}?\bmodels?\b/i,
  /\bmodels?\b[^.]{0,48}?\b(unknown|invalid|unsupported|unrecognized|unrecognised|no such|not found|missing|does not exist|doesn't exist|not available|retired|deprecated|disabled)\b/i,
  /\bmodel_(not_found|not_supported|invalid|unavailable)\b/i,
];

function truncate(value: string, max = 300) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeTransportFailure(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError")
      return "the provider did not answer in time";
    if (error.name === "AbortError") return "the request was aborted";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `the provider could not be reached (${truncate(message, 200)})`;
}

function buildInvalidMessage(params: {
  evaluatorName: string;
  provider: string;
  model: string;
}) {
  // Upstream's wording for the model half (evaluator-preflight.ts:128-130); we
  // add which connection the pair came from, because a decision-model evaluator
  // names its connection explicitly.
  return `Model configuration not valid for decision-model evaluator "${params.evaluatorName}". The provider could not find model '${params.model}' on connection "${params.provider}" — it may be retired, misspelled, or not available to your API key. Update the evaluator's model or the connection's model list.`;
}

function buildUnverifiedMessage(params: {
  evaluatorName: string;
  provider: string;
  model: string;
  reason: string;
  detail: string;
}) {
  return `Decision-model evaluator "${params.evaluatorName}" was saved without verifying model '${params.model}' on connection "${params.provider}": ${params.reason}. ${params.detail} The save was allowed because this looks like a reachability problem rather than a model problem.`;
}

function classifyFailure(params: {
  evaluatorName: string;
  provider: string;
  model: string;
  observation: DecisionModelProbeObservation;
  error: unknown;
}): DecisionModelPreflightOutcome {
  const { observation } = params;
  const status = observation.status;

  if (observation.transportError !== undefined) {
    const reason = describeTransportFailure(observation.transportError);
    const detail = "No provider response was received.";
    return {
      status: "unverified",
      reason,
      detail,
      message: buildUnverifiedMessage({ ...params, reason, detail }),
    };
  }

  const body = observation.body ?? "";
  const modelVerdictInBody = MODEL_VERDICT_PATTERNS.some((pattern) =>
    pattern.test(body),
  );

  // A 404 is the provider's own "I do not know this model" (upstream treats it
  // the same way), and any 4xx whose body names the model unusable is the same
  // verdict with a different status code.
  if (
    status === 404 ||
    (status !== undefined && status < 500 && modelVerdictInBody)
  ) {
    return {
      status: "invalid",
      message: buildInvalidMessage(params),
    };
  }

  const reason =
    status === undefined
      ? "the request failed before the provider answered"
      : status === 451
        ? "the provider is unavailable from this region (HTTP 451)"
        : status >= 500
          ? `the provider returned a server error (HTTP ${status})`
          : `the provider returned HTTP ${status}`;
  const detail =
    status === undefined
      ? `Local error: ${truncate(
          params.error instanceof Error
            ? params.error.message
            : String(params.error),
          200,
        )}`
      : body
        ? `Provider said: ${truncate(body, 200)}`
        : "The provider gave no further detail.";

  return {
    status: "unverified",
    reason,
    detail,
    message: buildUnverifiedMessage({ ...params, reason, detail }),
  };
}

/**
 * Runs the one real provider call that falsifies a decision-model name.
 *
 * `createClient` is only invoked when the probe actually runs, so a skipped
 * preflight cannot even construct a client (no proxy agent, no request).
 */
export async function runDecisionModelPreflight(params: {
  evaluatorName: string;
  provider: string;
  model: string;
  previousModel?: DecisionModelPreflightModel | null;
  probe?: DecisionModelRequest;
  observation: DecisionModelProbeObservation;
  createClient: () => DecisionModelClient;
}): Promise<DecisionModelPreflightOutcome> {
  if (
    !isDecisionModelPreflightRequired({
      provider: params.provider,
      model: params.model,
      previousModel: params.previousModel,
    })
  ) {
    return { status: "skipped", reason: "unchanged-provider-and-model" };
  }

  try {
    const client = params.createClient();
    await client.evaluate(params.probe ?? DECISION_MODEL_PREFLIGHT_PROBE);
    return { status: "valid" };
  } catch (error) {
    return classifyFailure({
      evaluatorName: params.evaluatorName,
      provider: params.provider,
      model: params.model,
      observation: params.observation,
      error,
    });
  }
}
