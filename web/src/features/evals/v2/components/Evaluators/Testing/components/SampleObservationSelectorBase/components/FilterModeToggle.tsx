import { Braces, ListFilter } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Tabs } from "@/src/components/design-system/Tabs/Tabs";
import type { EvaluatorFilterExperience } from "@/src/features/evals/v2/types/evaluatorFilterExperience";

export function FilterModeToggle({
  mode,
  onChange,
}: {
  mode: EvaluatorFilterExperience;
  onChange: (mode: EvaluatorFilterExperience) => void;
}) {
  const { t } = useTranslation();
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => onChange(value as EvaluatorFilterExperience)}
    >
      <Tabs.List aria-label={t("Filter editor mode")}>
        <Tabs.Trigger value="query" icon={Braces} label={t("Query")} />
        <Tabs.Trigger value="builder" icon={ListFilter} label={t("Builder")} />
      </Tabs.List>
    </Tabs>
  );
}
