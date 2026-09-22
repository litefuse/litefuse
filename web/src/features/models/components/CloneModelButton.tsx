import { Button } from "@/src/components/ui/button";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { UpsertModelFormDialog } from "@/src/features/models/components/UpsertModelFormDialog";
import { type GetModelResult } from "@/src/features/models/validation";

import { useTranslation } from "react-i18next";
export const CloneModelButton = ({
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
      action="clone"
    >
      <Button
        variant="outline"
        disabled={!hasAccess}
        title={t("Clone model")}
        className="flex items-center"
      >
        <span>{t("Clone")}</span>
      </Button>
    </UpsertModelFormDialog>
  );
};
