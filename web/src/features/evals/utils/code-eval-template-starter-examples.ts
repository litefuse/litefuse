// ── LITEFUSE NOTE (authored file; replaces the copied upstream one) ─────────
// Upstream's version is ~600 lines of embedded starter sources plus contract
// strings for previous contract versions, and its format/validate helpers import
// \`@astral-sh/ruff-wasm-web\` and prettier's estree plugin — packages we do not
// install. All of that belongs to code evaluation, which Litefuse deliberately
// does not wire up.
//
// The evaluator tree only uses \`getDefaultCodeEvalSource\` (to seed the editor),
// so that is all this file provides: a small, honest starter snippet per language
// with no validation or formatting dependency.
// ─────────────────────────────────────────────────────────────────────────────

export type CodeEvalSourceCodeLanguage = "PYTHON" | "TYPESCRIPT";

const TYPESCRIPT_STARTER = `function evaluate(ctx: EvaluationContext): EvaluationResult {
  // Return a score between 0 and 1 for the observation under evaluation.
  return { score: 0, reasoning: "Not implemented" };
}
`;

const PYTHON_STARTER = `def evaluate(ctx: EvaluationContext) -> EvaluationResult:
    # Return a score between 0 and 1 for the observation under evaluation.
    return EvaluationResult(score=0, reasoning="Not implemented")
`;

export function getDefaultCodeEvalSource(
  language: CodeEvalSourceCodeLanguage,
): string {
  return language === "PYTHON" ? PYTHON_STARTER : TYPESCRIPT_STARTER;
}
