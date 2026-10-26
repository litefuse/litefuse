import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { AIAssistedInput } from "@/src/components/ui/ai-assisted-input";
import { Label } from "@/src/components/ui/label";
import { InfoTooltip } from "@/src/components/ui/InfoTooltip/InfoTooltip";
import { Stepper } from "@/src/features/evals/v2/components/Stepper/Stepper";
import { i18nKey } from "@/src/features/i18n/i18nKey";

const COPY = {
  default: {
    description: i18nKey(
      "Give the evaluator a clear name (it's also used as the score name) and explain when it should be used.",
    ),
  },
  decisionModel: {
    description: i18nKey(
      "Give the evaluator a clear name and explain when it should be used.",
    ),
  },
} as const;

export function NameStep({
  step,
  variant,
  open,
  onOpenChange,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  nameAIAssistance,
  descriptionAIAssistance,
}: {
  step: number;
  variant: keyof typeof COPY;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (name: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  nameAIAssistance: ComponentProps<typeof AIAssistedInput>["aiAssistance"];
  descriptionAIAssistance: ComponentProps<
    typeof AIAssistedInput
  >["aiAssistance"];
}) {
  const { t } = useTranslation();
  return (
    <Stepper
      number={step}
      title={t("Name evaluator")}
      description={t(COPY[variant].description)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="evaluator-name" className="flex items-center gap-1.5">
            {t("Name")}
            {variant === "default" ? (
              <InfoTooltip label={t("About evaluator names")}>
                {t(
                  "The evaluator name is also used as the score name for the scores it produces.",
                )}
              </InfoTooltip>
            ) : null}
          </Label>
          <AIAssistedInput
            id="evaluator-name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={
              nameAIAssistance.state === "generating"
                ? t("Generating a name…")
                : t("Evaluator name")
            }
            aiAssistance={nameAIAssistance}
          />
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="evaluator-description"
            className="flex items-center gap-1"
          >
            {t("Description")}
            <span className="text-muted-foreground font-normal">
              {t("(optional)")}
            </span>
          </Label>
          <AIAssistedInput
            id="evaluator-description"
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder={
              descriptionAIAssistance.state === "generating"
                ? t("Generating a description…")
                : t("Describe what this evaluator measures")
            }
            fieldName="description"
            aiAssistance={descriptionAIAssistance}
          />
        </div>
      </div>
    </Stepper>
  );
}
