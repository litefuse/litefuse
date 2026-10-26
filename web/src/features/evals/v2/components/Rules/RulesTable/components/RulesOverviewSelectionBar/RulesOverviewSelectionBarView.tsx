import { Pause, Play, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/src/components/ui/button";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { OverviewSelectionBar } from "@/src/features/evals/v2/components/OverviewSelectionBar/OverviewSelectionBar";

export function RulesOverviewSelectionBarView({
  selectedCount,
  hasWriteAccess,
  statusChangePending,
  deletePending,
  deleteDialogOpen,
  onClear,
  onEnable,
  onDisable,
  onDelete,
  onDeleteDialogOpenChange,
  onConfirmDelete,
}: {
  selectedCount: number;
  hasWriteAccess: boolean;
  statusChangePending: boolean;
  deletePending: boolean;
  deleteDialogOpen: boolean;
  onClear: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onDelete: () => void;
  onDeleteDialogOpenChange: (open: boolean) => void;
  onConfirmDelete: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <OverviewSelectionBar selectedCount={selectedCount} onClear={onClear}>
        {/* Bulk enable/disable/delete all need `evaluationRule:CUD`. Read-only
            roles keep the selection (so they can see what they picked) but are
            not offered an action that the server would reject. */}
        {hasWriteAccess ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={statusChangePending}
              onClick={onEnable}
            >
              <Play className="mr-2 h-4 w-4" /> {t("Enable")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={statusChangePending}
              onClick={onDisable}
            >
              <Pause className="mr-2 h-4 w-4" /> {t("Disable")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" /> {t("Delete")}
            </Button>
          </>
        ) : null}
      </OverviewSelectionBar>
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={onDeleteDialogOpenChange}
        title={t("Delete evaluation rules?")}
        description={
          selectedCount === 1
            ? t(
                "This permanently deletes {{ruleCount}} rule and its evaluator assignments.",
                { ruleCount: selectedCount },
              )
            : t(
                "This permanently deletes {{ruleCount}} rules and its evaluator assignments.",
                { ruleCount: selectedCount },
              )
        }
        confirmLabel={t("Delete")}
        loading={deletePending}
        onConfirm={onConfirmDelete}
      />
    </>
  );
}
