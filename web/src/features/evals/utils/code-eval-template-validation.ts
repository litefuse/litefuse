// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Upstream's version is ~1040 lines: it type-checks user TypeScript with the
// bundled tsc and lints Python with a WASM ruff build. Both depend on packages
// we do not install (@typescript/typescript6, @astral-sh/ruff-wasm-web), and the
// whole feature belongs to code evaluation, which Litefuse does not wire up.
//
// The RESULT CONTRACT is kept intact so the UI that consumes it (the code
// editor's diagnostics panel, the setup footer's validity gate) compiles and
// behaves sanely: nothing is validated, so the source is always treated as
// valid and no diagnostics are reported.
// ─────────────────────────────────────────────────────────────────────────────

import type { EvalTemplateSourceCodeLanguage } from "@/src/features/evals/server/isCodeEvalEnabled";

export type CodeEvalDiagnostic = {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
};

export type CodeEvalValidationResult = {
  diagnostics: CodeEvalDiagnostic[];
  hasErrors: boolean;
  sourceBytes: number;
};

export async function validateCodeEvalSourceWithLanguage({
  sourceCode,
}: {
  sourceCode: string;
  sourceCodeLanguage: EvalTemplateSourceCodeLanguage;
}): Promise<CodeEvalValidationResult> {
  return {
    diagnostics: [],
    // Code evaluation is not wired up, so nothing can be reported as invalid.
    hasErrors: false,
    sourceBytes: sourceCode.length,
  };
}
