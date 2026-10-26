import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Stepper } from "@/src/features/evals/v2/components/Stepper/Stepper";
import { i18nKey } from "@/src/features/i18n/i18nKey";

const COPY = {
  variables: {
    title: i18nKey("Map variables to data"),
    description: i18nKey(
      "Choose how observation fields populate each variable in your evaluation prompt. The live preview fills in real data so you can verify the mapping.",
    ),
  },
  state: {
    title: i18nKey("Build the state"),
    description: i18nKey(
      "Choose which observation fields the decision model sees, as one JSON object. Questions refer to these fields by name; the live preview shows the exact object sent.",
    ),
  },
} as const;

export function VariableMappingStep({
  open,
  onOpenChange,
  mappingEditor,
  variant = "variables",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mappingEditor: ReactNode;
  /** Prompt variables of an LLM judge, or the state of a decision model. */
  variant?: keyof typeof COPY;
}) {
  const { t } = useTranslation();
  return (
    <Stepper
      number={2}
      title={t(COPY[variant].title)}
      description={t(COPY[variant].description)}
      open={open}
      onOpenChange={onOpenChange}
    >
      {mappingEditor}
    </Stepper>
  );
}
