// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Upstream debounces source edits and runs the real validator (tsc / ruff) on
// every settle. Litefuse has no code-eval engine, so this keeps the hook's shape
// — the consumers read \`isPending\` / \`isValid\` / \`validationResult\` and call
// \`validate()\` before saving — but resolves immediately with "valid".
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useState } from "react";

import type { EvalTemplateSourceCodeLanguage } from "@/src/features/evals/server/isCodeEvalEnabled";
import {
  validateCodeEvalSourceWithLanguage,
  type CodeEvalValidationResult,
} from "@/src/features/evals/utils/code-eval-template-validation";

export function useCodeEvalSourceValidation({
  enabled,
  sourceCode,
  sourceCodeLanguage,
}: {
  enabled: boolean;
  sourceCode: string;
  sourceCodeLanguage: EvalTemplateSourceCodeLanguage;
}) {
  const [validationResult, setValidationResult] =
    useState<CodeEvalValidationResult | null>(null);
  const [isPending, setIsPending] = useState(false);

  /**
   * LITEFUSE NOTE: upstream's `validate(params?)` lets the caller validate the
   * values it just read (the save path reads the store, not the render-time
   * props), falling back to the hook's own inputs. Same contract here, so the
   * copied evaluators v2 call sites work unchanged.
   */
  const validate = useCallback(
    async (params?: {
      sourceCode?: string;
      sourceCodeLanguage?: EvalTemplateSourceCodeLanguage;
    }) => {
      if (!enabled) return true;
      const nextSourceCode = params?.sourceCode ?? sourceCode;
      const nextSourceCodeLanguage =
        params?.sourceCodeLanguage ?? sourceCodeLanguage;
      setIsPending(true);
      try {
        const result = await validateCodeEvalSourceWithLanguage({
          sourceCode: nextSourceCode,
          sourceCodeLanguage: nextSourceCodeLanguage,
        });
        setValidationResult(result);
        return !result.hasErrors;
      } finally {
        setIsPending(false);
      }
    },
    [enabled, sourceCode, sourceCodeLanguage],
  );

  const isValid = useMemo(
    () => !enabled || !isPending,
    [enabled, isPending],
  );

  return { isPending, isValid, validate, validationResult };
}
