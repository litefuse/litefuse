"use client";

// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Upstream's version is a ~440-line CodeMirror editor with lint diagnostics, a
// format button and language-specific hover docs. It is part of code
// evaluation, which Litefuse does not wire up, and it needs CodeMirror language
// packages we do not install (@codemirror/lang-python, lang-javascript).
//
// The evaluator type and its UI entry point are kept, but this body is a
// placeholder that states the situation instead of pretending to be an editor.
// The prop contract is preserved so the surrounding setup flow compiles
// unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { AlertCircle } from "lucide-react";

import type { EvalTemplateSourceCodeLanguage } from "@/src/features/evals/server/isCodeEvalEnabled";
import type { CodeEvalValidationResult } from "@/src/features/evals/utils/code-eval-template-validation";

export type CodeEvalTemplateFormBodyProps = {
  sourceCode: string;
  sourceCodeLanguage: EvalTemplateSourceCodeLanguage;
  onSourceCodeChange?: (value: string) => void;
  editable?: boolean;
  validationResult?: CodeEvalValidationResult | null;
  ctxSample?: string | null;
  headerAction?: React.ReactNode;
};

export function CodeEvalTemplateFormBody({
  sourceCode,
  sourceCodeLanguage,
}: CodeEvalTemplateFormBodyProps) {
  return (
    <div
      className="text-muted-foreground flex flex-col gap-2 rounded-md border p-4 text-sm"
      data-testid="code-eval-not-wired"
    >
      <div className="text-foreground flex items-center gap-2 font-medium">
        <AlertCircle className="h-4 w-4" />
        Code evaluation is not wired up in this deployment
      </div>
      <p>
        The evaluator type and this editor entry point are kept so the setup flow
        stays complete, but there is no execution path: Litefuse ships neither the
        AWS Lambda dispatcher nor local code execution. See the integration plan in
        the documentation.
      </p>
      <pre className="bg-muted max-h-64 overflow-auto rounded p-3 text-xs">
        <code>{sourceCode}</code>
      </pre>
      <span className="text-xs">Language: {sourceCodeLanguage}</span>
    </div>
  );
}
