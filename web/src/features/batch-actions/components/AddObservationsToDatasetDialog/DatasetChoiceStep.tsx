import { Database, Plus } from "lucide-react";
import type { DatasetChoiceStepProps } from "./types";

import { useTranslation } from "react-i18next";
export function DatasetChoiceStep(props: DatasetChoiceStepProps) {
  const { t } = useTranslation();
  const { onSelectMode } = props;

  return (
    <div className="grid grid-cols-2 gap-6 p-6">
      {/* Existing Dataset Card */}
      <button
        type="button"
        onClick={() => onSelectMode("select")}
        className="hover:border-tertiary hover:bg-accent flex flex-col items-center rounded-lg border-2 p-8 text-center transition-all"
      >
        <div className="bg-primary/10 mb-4 rounded-full p-4">
          <Database className="text-primary h-8 w-8" />
        </div>
        <h3 className="mb-2 text-lg font-semibold">{t("Existing Dataset")}</h3>
        <p className="text-muted-foreground text-sm">
          {t("Add to a dataset that already exists")}
        </p>
      </button>

      {/* New Dataset Card */}
      <button
        type="button"
        onClick={() => onSelectMode("create")}
        className="hover:border-tertiary hover:bg-accent flex flex-col items-center rounded-lg border-2 p-8 text-center transition-all"
      >
        <div className="bg-primary/10 mb-4 rounded-full p-4">
          <Plus className="text-primary h-8 w-8" />
        </div>
        <h3 className="mb-2 text-lg font-semibold">{t("New Dataset")}</h3>
        <p className="text-muted-foreground text-sm">
          {t("Create a new dataset for these observations")}
        </p>
      </button>
    </div>
  );
}
