import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";

export function EvaluatorBulkDeleteDialog({
  open,
  scope,
  isDeleting,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  scope: "selected" | "allMatching";
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        scope === "allMatching"
          ? t("Delete all matching evaluators?")
          : t("Delete selected evaluators?")
      }
      description={t(
        "All versions and evaluation rule assignments will be deleted.",
      )}
      confirmLabel={t("Delete evaluators")}
      loading={isDeleting}
      onConfirm={onConfirm}
    />
  );
}
