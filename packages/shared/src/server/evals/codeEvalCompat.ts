// ── LITEFUSE NOTE (authored; replaces upstream's code-eval dispatcher entry) ──
// Upstream runs user-supplied Python/TypeScript either in AWS Lambda
// (\`AwsLambdaCodeEvalDispatcher\`) or in-process (\`LocalCodeEvalDispatcher\`,
// which logs an "insecure local execution" warning). Both introduce an
// "execute untrusted user code" surface.
//
// Litefuse decision: keep the evaluator type, its UI entry point and its
// messaging, but ship NO execution path.
// This file expresses that in one place:
//   - \`resolveConfiguredCodeEvalDispatcher\` always returns null, so every caller
//     takes its existing "dispatcher is not configured" branch and the user sees a
//     clear message instead of a silent failure.
//   - \`runCodeBasedEvaluationDispatch\` exists only so the guarded call site still
//     compiles, and throws if anyone ever reaches it.
//
// Replacement suggestion: when code evaluation is wanted, decide the sandbox story
// first (AWS Lambda vs. in-process local execution), then implement a real
// dispatcher here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No dispatcher is configured in Litefuse. Returning null is the documented signal
 * callers already handle.
 */
export function resolveConfiguredCodeEvalDispatcher(): null {
  return null;
}

/** Unreachable in Litefuse: the dispatcher is always null. */
export async function runCodeBasedEvaluationDispatch(
  _params: Record<string, unknown>,
): Promise<never> {
  throw new Error(
    "Code evaluation is not wired up in this deployment: neither the AWS Lambda dispatcher nor local code execution is available.",
  );
}
