import { Button } from "@/src/components/ui/button";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { UpsertModelFormDialog } from "@/src/features/models/components/UpsertModelFormDialog";
import { type GetModelResult } from "@/src/features/models/validation";

import { useTranslation } from "react-i18next";
export const EditModelButton = ({
  modelData,
  projectId,
}: {
  modelData: GetModelResult;
  projectId: string;
}) => {
  const { t } = useTranslation();
  const hasAccess = useHasProjectAccess({
    projectId,
    scope: "models:CUD",
  });

  return (
    <UpsertModelFormDialog
      modelData={modelData}
      projectId={projectId}
      action="edit"
    >
      <Button
        variant="outline"
        disabled={!hasAccess}
        title={t("Edit model")}
        className="flex items-center"
      >
        <span>{t("Edit")}</span>
      </Button>
    </UpsertModelFormDialog>
  );
};
