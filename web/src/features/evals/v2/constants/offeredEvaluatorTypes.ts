import { EvalTemplateTypeEnum, type EvalTemplateType } from "@langfuse/shared";

/**
 * The evaluator implementations the UI offers, in the order they are shown.
 *
 * Code evaluators are deliberately absent: this build ships no execution path
 * for them (`getCodeEvalCapabilities` is always empty), so the editor could
 * never be saved and offering their templates only leads to a dead end. Their
 * editor, validation and rendering code is kept so that existing evaluators and
 * the public API stay readable.
 */
export const OFFERED_EVALUATOR_TYPES: readonly EvalTemplateType[] = [
  EvalTemplateTypeEnum.LLM_AS_JUDGE,
  EvalTemplateTypeEnum.DECISION_MODEL,
];

export function isOfferedEvaluatorType(type: EvalTemplateType): boolean {
  return OFFERED_EVALUATOR_TYPES.includes(type);
}
