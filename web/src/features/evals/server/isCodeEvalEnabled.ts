// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Upstream gates code evaluations on \`env.LANGFUSE_CODE_EVAL_DISPATCHER\`
// (aws-lambda / insecure-local). Litefuse deliberately ships NEITHER dispatcher:
// code evaluation keeps its type, its UI entry point and its "not wired yet"
// messaging, but has no execution path — no Lambda, no local code execution.
//
// That decision is expressed here, in one place: capabilities are always empty, so
// every caller takes its "code evals are not enabled" branch.
// ─────────────────────────────────────────────────────────────────────────────

export type EvalTemplateSourceCodeLanguage = "PYTHON" | "TYPESCRIPT";

export type CodeEvalCapabilities = {
  enabled: boolean;
  supportedSourceCodeLanguages: EvalTemplateSourceCodeLanguage[];
};

export function getCodeEvalCapabilities(): CodeEvalCapabilities {
  return { enabled: false, supportedSourceCodeLanguages: [] };
}

export function isCodeEvalEnabled(): boolean {
  return getCodeEvalCapabilities().enabled;
}

/** Empty when code evals are disabled, so callers can filter on it directly. */
export function getSupportedCodeEvalTemplateLanguages(): EvalTemplateSourceCodeLanguage[] {
  return getCodeEvalCapabilities().supportedSourceCodeLanguages;
}

export function isCodeEvalSourceCodeLanguageSupported(
  sourceCodeLanguage: EvalTemplateSourceCodeLanguage | string | null | undefined,
): boolean {
  if (!sourceCodeLanguage) return false;
  return getCodeEvalCapabilities().supportedSourceCodeLanguages.includes(
    sourceCodeLanguage as EvalTemplateSourceCodeLanguage,
  );
}
