import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { type EvalTemplateType } from "@langfuse/shared";

import { Label } from "@/src/components/ui/label";
import { InfoTooltip } from "@/src/components/ui/InfoTooltip/InfoTooltip";
import { EvaluationTypeToggle } from "./components/EvaluationTypeToggle/EvaluationTypeToggle";

/** Shared execution row; its container owns which mode-specific selector follows it. */
export function EvaluationTypeConfiguration({
  mode,
  onModeChange,
  disabled,
  children,
}: {
  mode: EvalTemplateType;
  onModeChange: (mode: EvalTemplateType) => void;
  disabled: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      <Label className="flex items-center gap-1.5">
        {t("Evaluation")}
        <span className="inline-flex -translate-y-px">
          <InfoTooltip label={t("About evaluation types")}>
            {t(
              "Use custom code for deterministic checks like exact matches, regex, or schema validation. Use an LLM when the check needs judgment, such as rating helpfulness, tone, or answer quality. Use a decision model (experimental) for a fast, cheap label with calibrated probabilities when the possible answers are known upfront.",
            )}
          </InfoTooltip>
        </span>
      </Label>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t("Run")}</span>
        <EvaluationTypeToggle
          value={mode}
          onValueChange={onModeChange}
          disabled={disabled}
        />
        <span>{mode === "CODE" ? t("written in") : t("with")}</span>
        {children}
      </div>
    </div>
  );
}
