import { Scale, Sparkles } from "lucide-react";
import { EvalTemplateTypeEnum, type EvalTemplateType } from "@langfuse/shared";
import { useTranslation } from "react-i18next";

import { Tabs } from "@/src/components/design-system/Tabs/Tabs";

/**
 * Selects the evaluator implementation.
 *
 * Code evaluators are not offered here: this build has no execution path for
 * them, so their form could never be saved. See `OFFERED_EVALUATOR_TYPES`.
 */
export function EvaluationTypeToggle({
  value,
  onValueChange,
  disabled = false,
}: {
  value: EvalTemplateType;
  onValueChange: (value: EvalTemplateType) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Tabs
      value={value}
      onValueChange={(mode) => onValueChange(mode as EvalTemplateType)}
    >
      <Tabs.List variant="outline">
        {!disabled || value === EvalTemplateTypeEnum.LLM_AS_JUDGE ? (
          <Tabs.Trigger
            value={EvalTemplateTypeEnum.LLM_AS_JUDGE}
            disabled={disabled}
            icon={Sparkles}
            label={t("LLM-as-a-judge")}
          />
        ) : null}
        {!disabled || value === EvalTemplateTypeEnum.DECISION_MODEL ? (
          <Tabs.Trigger
            value={EvalTemplateTypeEnum.DECISION_MODEL}
            disabled={disabled}
            icon={Scale}
            label={t("Decision model (experimental)")}
          />
        ) : null}
      </Tabs.List>
    </Tabs>
  );
}
