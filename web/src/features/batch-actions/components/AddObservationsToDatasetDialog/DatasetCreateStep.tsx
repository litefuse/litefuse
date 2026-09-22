import { DatasetForm } from "@/src/features/datasets/components/DatasetForm";
import type { DatasetCreateStepProps } from "./types";

import { useTranslation } from "react-i18next";
export function DatasetCreateStep(props: DatasetCreateStepProps) {
  const { t } = useTranslation();
  const { projectId, formRef, onDatasetCreated, onValidationChange } = props;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h3 className="text-lg font-medium">{t("Create New Dataset")}</h3>
        <p className="text-muted-foreground text-sm">
          {t("Fill in the details to create a new dataset")}
        </p>
      </div>

      <DatasetForm
        ref={formRef}
        projectId={projectId}
        mode="create"
        redirectOnSuccess={false}
        showFooter={false}
        onCreateDatasetSuccess={onDatasetCreated}
        onValidationChange={onValidationChange}
      />
    </div>
  );
}
