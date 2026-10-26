import { EvaluatorBlockReason } from "@prisma/client";

const LLMCompletionErrorName = "LLMCompletionError";

const BLOCK_REASON_PATTERNS = [
  {
    pattern: "Model use case details have not been submitted for this account",
    blockReason: EvaluatorBlockReason.PROVIDER_ACCOUNT_NOT_READY,
  },
] as const;

export function inferLLMCompletionBlockReason(params: {
  responseStatusCode: number;
  message: string;
}): EvaluatorBlockReason | null {
  if (params.responseStatusCode === 401) {
    return EvaluatorBlockReason.LLM_CONNECTION_AUTH_INVALID;
  }

  if (params.responseStatusCode === 404) {
    return EvaluatorBlockReason.EVAL_MODEL_UNAVAILABLE;
  }

  const reasonByMessage = BLOCK_REASON_PATTERNS.find((entry) =>
    params.message.includes(entry.pattern),
  );

  return reasonByMessage?.blockReason ?? null;
}

export class LLMCompletionError extends Error {
  responseStatusCode: number;
  isRetryable: boolean;
  blockReason: EvaluatorBlockReason | null;
  /**
   * LITEFUSE ADDITION. True when the failure was our own client-side timeout
   * rather than a provider response.
   *
   * Our LLM layer applies the timeout itself (`timeout:
   * LITEFUSE_FETCH_LLM_COMPLETION_TIMEOUT_MS` on the LangChain client,
   * fetchLLMCompletion.ts:287/344/351) and then wraps *every* failure into this
   * class without attaching the cause, so the underlying
   * `APIConnectionTimeoutError` / `TimeoutError` is lost and the failure looks
   * exactly like a generic HTTP 500. `getLLMErrorInfo` therefore reported
   * `kind: "provider"` for a timeout, and a save-time preflight would read that
   * as a verdict about the model — writing a block the provider never asked for.
   * Upstream reads native AI SDK errors, where `kind` comes out `"timeout"` on
   * its own.
   */
  isTimeout: boolean;

  constructor(params: {
    message: string;
    responseStatusCode?: number;
    isRetryable?: boolean;
    isTimeout?: boolean;
  }) {
    super(params.message);

    this.name = LLMCompletionErrorName;
    this.responseStatusCode = params.responseStatusCode ?? 500;
    this.isRetryable = params.isRetryable ?? false; // Default to false - be explicit about retryability
    this.isTimeout = params.isTimeout ?? false;
    this.blockReason = inferLLMCompletionBlockReason({
      responseStatusCode: this.responseStatusCode,
      message: this.message,
    });

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this);
    }
  }

  shouldBlockConfig(): boolean {
    return this.blockReason !== null;
  }

  getEvaluatorBlockReason(): EvaluatorBlockReason | null {
    return this.blockReason;
  }
}

export function isLLMCompletionError(e: any): e is LLMCompletionError {
  return e instanceof Error && e.name === LLMCompletionErrorName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Added for the evaluators v2 migration. Adapted for decision U1: upstream reads
// native AI SDK errors; our LLM layer (fetchLLMCompletion, LangChain-based)
// reports failures as our own LLMCompletionError, so the provider branch below
// detects that instead. Everything else — the Langfuse-owned validation error, the
// timeout/abort detection, the cause-chain walk — is upstream's code, and the
// "unknown errors return null" contract is kept deliberately: callers must not
// expose internal messages or mistake a bug for an LLM failure.
// ─────────────────────────────────────────────────────────────────────────────

const LLM_VALIDATION_ERROR_MARKER = Symbol.for(
  "langfuse.error.LLMValidationError",
);

export type LLMValidationErrorCode =
  | "invalid-connection"
  | "invalid-request"
  | "endpoint-unreachable";

/**
 * A deterministic validation failure owned by us, before or around the provider
 * call. Provider failures remain native errors.
 */
export class LLMValidationError extends Error {
  private readonly [LLM_VALIDATION_ERROR_MARKER] = true;

  readonly code: LLMValidationErrorCode;
  readonly statusCode = 400;

  constructor(params: {
    code: LLMValidationErrorCode;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "LLMValidationError";
    this.code = params.code;
  }

  static isInstance(error: unknown): error is LLMValidationError {
    return (
      error !== null &&
      typeof error === "object" &&
      LLM_VALIDATION_ERROR_MARKER in error &&
      error[LLM_VALIDATION_ERROR_MARKER] === true
    );
  }
}

export type LLMErrorInfo = {
  kind: "provider" | "validation" | "timeout" | "abort";
  message: string;
  statusCode?: number;
  isRetryable: boolean;
  error: unknown;
  providerError?: LLMCompletionError;
  validationError?: LLMValidationError;
};

/**
 * Reads our own LLM/validation errors without replacing them. Unknown application
 * errors intentionally return null so callers do not accidentally expose internal
 * messages or treat internal bugs as LLM errors.
 */
export function getLLMErrorInfo(error: unknown): LLMErrorInfo | null {
  const validationError = findInCauseChain(
    error,
    LLMValidationError.isInstance,
  );
  if (validationError) {
    return {
      kind: "validation",
      message: validationError.message,
      statusCode: validationError.statusCode,
      isRetryable: false,
      error,
      validationError,
    };
  }

  const providerError = findInCauseChain(error, isLLMCompletionError);
  if (providerError) {
    // LITEFUSE ADDITION: a client-side timeout carries no provider verdict.
    // Report it with upstream's `timeout` kind so callers classify it as
    // operational (upstream's `isOperationalError`) instead of mistaking it for
    // a statement about the model.
    if (providerError.isTimeout) {
      return {
        kind: "timeout",
        message: providerError.message,
        statusCode: providerError.responseStatusCode,
        isRetryable: providerError.isRetryable,
        error,
        providerError,
      };
    }
    return {
      kind: "provider",
      message: providerError.message,
      statusCode: providerError.responseStatusCode,
      isRetryable: providerError.isRetryable,
      error,
      providerError,
    };
  }

  const timeoutError = findErrorByName(error, "TimeoutError");
  if (timeoutError) {
    return {
      kind: "timeout",
      message: timeoutError.message,
      isRetryable: false,
      error,
    };
  }

  const abortError = findErrorByName(error, "AbortError");
  if (abortError) {
    return {
      kind: "abort",
      message: abortError.message,
      isRetryable: false,
      error,
    };
  }

  return null;
}

function findErrorByName(error: unknown, name: string): Error | undefined {
  return findInCauseChain(
    error,
    (candidate): candidate is Error =>
      candidate instanceof Error && candidate.name === name,
  );
}

function findInCauseChain<T>(
  error: unknown,
  predicate: (candidate: unknown) => candidate is T,
): T | undefined {
  const visited = new Set<unknown>();
  let current = error;

  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current);
    if (predicate(current)) return current;

    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }

  return undefined;
}
