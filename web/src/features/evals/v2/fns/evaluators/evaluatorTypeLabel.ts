import { EvalTemplateTypeEnum, type EvalTemplateType } from "@langfuse/shared";

import { i18nKey } from "@/src/features/i18n/i18nKey";

/** Product wording for each evaluator type, shared by badges and filters. */
export function evaluatorTypeLabel(type: EvalTemplateType): string {
  switch (type) {
    case EvalTemplateTypeEnum.CODE:
      return i18nKey("Code");
    case EvalTemplateTypeEnum.DECISION_MODEL:
      return i18nKey("Decision model (experimental)");
    case EvalTemplateTypeEnum.LLM_AS_JUDGE:
      return i18nKey("LLM as a judge");
  }
}
