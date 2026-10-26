import { useRouter } from "next/router";
import { Skeleton } from "@/src/components/ui/skeleton";
import TableLink from "@/src/components/table/table-link";
import { CardDescription } from "@/src/components/ui/card";
import { EvaluatorForm } from "@/src/features/evals/components/evaluator-form";
import { usePeekEvalConfigData } from "@/src/components/table/peek/hooks/usePeekEvalConfigData";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/src/components/ui/tooltip";
import { LangfuseIcon } from "@/src/components/LangfuseLogo";
import { UserCircle2Icon } from "lucide-react";
import { StatusBadge } from "@/src/components/layouts/status-badge";
import { DeactivateEvalConfig } from "@/src/features/evals/components/deactivate-config";
import { Switch } from "@/src/components/ui/switch";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { useState } from "react";
import { cn } from "@/src/utils/tailwind";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { api } from "@/src/utils/api";
import { LegacyEvalCallout } from "@/src/features/evals/components/legacy-eval-callout";
import { EvaluatorPausedCallout } from "@/src/features/evals/components/evaluator-paused-callout";
import { isLegacyEvalTarget } from "@/src/features/evals/utils/typeHelpers";
import { useLazyEvaluatorExecutionCounts } from "@/src/features/evals/hooks/useLazyEvaluatorExecutionCounts";

import { useTranslation } from "react-i18next";

/** Product name, never translated. */
const LITEFUSE_MAINTAINER = "Litefuse";
export const PeekViewEvaluatorConfigDetail = ({
  projectId,
}: {
  projectId: string;
}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const peekId = router.query.peek as string | undefined;
  const [isEditMode, setIsEditMode] = useState(false);
  const utils = api.useUtils();

  const { data: evalConfig } = usePeekEvalConfigData({
    jobConfigurationId: peekId,
    projectId,
  });
  const lazyExecutionCounts = useLazyEvaluatorExecutionCounts({
    projectId,
    evaluatorId: evalConfig?.id,
    evaluator: evalConfig,
  });

  const hasAccess = useHasProjectAccess({ projectId, scope: "evalJob:CUD" });

  if (!evalConfig) {
    return <Skeleton className="h-full w-full rounded-none" />;
  }

  const displayStatus =
    lazyExecutionCounts.displayStatus ?? evalConfig.displayStatus;

  return (
    <div className="grid h-full flex-1 grid-rows-[auto_auto_1fr] gap-2 overflow-hidden p-3 contain-layout">
      <div className="flex items-center justify-between">
        <div className="flex flex-row items-center gap-2">
          <span className="max-h-fit text-lg font-medium">
            {t("Configuration")}
          </span>
          <div className="flex items-center gap-2">
            <StatusBadge
              type={displayStatus.toLowerCase()}
              isLive
              className="max-h-8"
            />
            {isLegacyEvalTarget(evalConfig.targetObject) && (
              <DeactivateEvalConfig
                projectId={projectId}
                evalConfig={evalConfig}
              />
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn("text-sm", isEditMode ? "" : "text-muted-foreground")}
          >
            {t("Edit Mode")}
          </span>
          <Switch
            disabled={
              !hasAccess ||
              (isLegacyEvalTarget(evalConfig.targetObject) &&
                evalConfig?.timeScope?.length === 1 &&
                evalConfig.timeScope[0] === "EXISTING")
            }
            checked={isEditMode}
            onCheckedChange={setIsEditMode}
          />
        </div>
      </div>

      {evalConfig &&
        evalConfig.targetObject &&
        evalConfig.evalTemplate &&
        displayStatus === "ACTIVE" && (
          <LegacyEvalCallout
            projectId={projectId}
            evalConfigId={evalConfig.id}
            targetObject={evalConfig.targetObject}
          />
        )}

      <EvaluatorPausedCallout projectId={projectId} evalConfig={evalConfig} />

      <CardDescription className="flex items-center text-sm">
        <span className="mr-2 text-sm font-medium">
          {t("Referenced Evaluator")}
        </span>
        {evalConfig.evalTemplate && (
          <TableLink
            path={`/project/${projectId}/evals/legacy/templates/${evalConfig.evalTemplate.id}`}
            value={evalConfig.evalTemplate.name}
            className="mr-1 flex min-h-6 items-center"
          />
        )}
        {evalConfig.evalTemplate && (
          <Tooltip>
            <TooltipTrigger>
              {evalConfig.evalTemplate.projectId === null ? (
                <LangfuseIcon size={16} />
              ) : (
                <UserCircle2Icon className="h-4 w-4" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {evalConfig.evalTemplate.partner ?? LITEFUSE_MAINTAINER}
            </TooltipContent>
          </Tooltip>
        )}
      </CardDescription>
      <div className="flex max-h-full w-full flex-col items-start justify-between space-y-2 overflow-y-auto pb-4">
        <EvaluatorForm
          key={`${evalConfig?.id}-${evalConfig?.updatedAt}-${isEditMode}`}
          projectId={projectId}
          evalTemplates={
            evalConfig?.evalTemplate ? [evalConfig.evalTemplate] : []
          }
          existingEvaluator={
            evalConfig.evalTemplate
              ? {
                  ...evalConfig,
                  evalTemplate: evalConfig.evalTemplate,
                }
              : undefined
          }
          mode="edit"
          disabled={!isEditMode}
          shouldWrapVariables={true}
          useDialog={false}
          onFormSuccess={() => {
            setIsEditMode(false);
            utils.evals.invalidate();
            showSuccessToast({
              title: t("Running Evaluator updated"),
              description: t(
                t("The evaluator configuration has been updated."),
              ),
            });
          }}
        />
      </div>
    </div>
  );
};

// ── Added for the evaluators v2 migration (adapter, not an upstream copy) ────
// Upstream: \`<TablePeekView {...peekProps}><PeekViewEvaluatorConfigDetail projectId readOnly /></TablePeekView>\`.
// We do not have \`TablePeekView\`, and our PeekViewEvaluatorConfigDetail takes no
// \`readOnly\`, so this delegates to ours and drops the shell props.
//
// ACCEPTED AND IGNORED: the \`PeekNavigation\` fields, \`itemType\`,
// \`detailNavigationKey\`, \`layout\` and the expand config. \`readOnly\` is accepted
// because the evaluator pages pass it, but our evaluator-config peek has no
// read-only mode yet — so an evaluator opened from a rule behaves as before rather
// than being locked. Recorded as an evaluator-page wiring item.
export const TablePeekViewEvaluatorConfigDetail = ({
  projectId,
}: {
  projectId: string;
  readOnly?: boolean;
} & Record<string, unknown>) => (
  <PeekViewEvaluatorConfigDetail projectId={projectId} />
);
