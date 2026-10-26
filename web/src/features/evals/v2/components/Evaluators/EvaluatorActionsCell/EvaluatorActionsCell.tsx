import {
  Copy,
  ListTree,
  MoreVertical,
  Pencil,
  Route,
  SquarePercent,
  Trash2,
} from "lucide-react";

import { Button } from "@/src/components/ui/button";
import {
  DropdownMenu,
  type DropdownMenuItemDefinition,
} from "@/src/components/design-system/DropdownMenu/DropdownMenu";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics";
import { useTranslation } from "react-i18next";

export function EvaluatorActionsCell({
  canEdit,
  canViewExecutions,
  canViewScores,
  ruleTracesLinks,
  onViewScores,
  onViewExecutions,
  onClone,
  onEdit,
  onDelete,
}: {
  /** `evaluator:CUD`. Without it the menu keeps only the read-only entries. */
  canEdit: boolean;
  canViewExecutions: boolean;
  /** False until the evaluator's own score names are known (or if it has none). */
  canViewScores: boolean;
  /**
   * The rules this evaluator is attached to, one entry per rule, each carrying
   * the `/traces` URL for the traces THAT rule evaluates. An evaluator has no
   * filter of its own — it is mounted by rules — so "View traces" is only
   * meaningful per rule. Empty when it is not attached to any rule.
   */
  ruleTracesLinks: Array<{ ruleId: string; ruleName: string; href: string }>;
  onViewScores: () => void;
  onViewExecutions: () => void;
  onClone: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const capture = usePostHogClientCapture();
  const { t } = useTranslation();

  const handlePrimaryAction = () => {
    capture("evaluators:overview_action_click", { action: "view_scores" });
    onViewScores();
  };

  const ruleTracesHrefs = ruleTracesLinks.map(({ ruleName, href }) => ({
    type: "item" as const,
    id: `view-traces-${href}`,
    title: ruleName,
    href,
  }));

  // One rule → go straight there. Several → the rule picker is the honest
  // shape, because the evaluator's traces are the union of its rules' filters
  // and a single union filter is not expressible on the traces surface.
  const viewTracesItem: DropdownMenuItemDefinition =
    ruleTracesHrefs.length === 1
      ? {
          type: "item",
          id: "view-traces",
          title: t("View traces"),
          icon: Route,
          href: ruleTracesHrefs[0].href,
        }
      : ruleTracesHrefs.length > 1
        ? {
            type: "submenu",
            id: "view-traces",
            title: t("View traces"),
            icon: Route,
            search: { placeholder: t("Search rules") },
            items: ruleTracesHrefs,
          }
        : {
            type: "item",
            id: "view-traces",
            title: t("View traces"),
            icon: Route,
            disabled: {
              reason: t("This evaluator is not attached to any rule"),
            },
            onClick: () => undefined,
          };

  return (
    <div className="flex w-full min-w-0 items-center justify-start gap-1">
      <Button
        type="button"
        variant="link"
        size="sm"
        className="text-foreground hover:text-foreground h-auto px-0 py-0"
        disabled={!canViewScores}
        title={
          canViewScores
            ? undefined
            : t("This evaluator has not produced any scores yet")
        }
        onClick={handlePrimaryAction}
      >
        {t("View scores")}
        <SquarePercent className="ml-1 h-3.5 w-3.5" />
      </Button>
      <DropdownMenu
        placement="bottom-end"
        items={[
          viewTracesItem,
          ...(canViewExecutions
            ? [
                {
                  type: "item" as const,
                  id: "view-executions",
                  title: t("View executions"),
                  icon: ListTree,
                  onClick: onViewExecutions,
                },
              ]
            : []),
          ...(canEdit
            ? [
                {
                  type: "item" as const,
                  id: "edit",
                  title: t("Edit"),
                  icon: Pencil,
                  onClick: onEdit,
                },
                {
                  type: "item" as const,
                  id: "clone",
                  title: t("Clone"),
                  icon: Copy,
                  onClick: onClone,
                },
                {
                  type: "item" as const,
                  id: "delete",
                  title: t("Delete"),
                  icon: Trash2,
                  onClick: onDelete,
                },
              ]
            : []),
        ]}
      >
        {({ getTriggerProps }) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("Evaluator actions")}
            className="shrink-0"
            {...getTriggerProps()}
          >
            <span className="sr-only">{t("Open menu")}</span>
            <MoreVertical className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenu>
    </div>
  );
}
