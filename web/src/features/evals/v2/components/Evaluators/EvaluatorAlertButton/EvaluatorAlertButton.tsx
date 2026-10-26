/* eslint-disable no-nested-ternary */
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Bell,
  ChevronDown,
  DollarSign,
  Gauge,
  LoaderCircle,
  Plus,
} from "lucide-react";
import type { EvalTemplateType } from "@langfuse/shared";

import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/src/components/ui/command";
import { PopoverController } from "@/src/components/ui/popover";
import {
  evaluatorAlertsListUrl,
  evaluatorAlertUrl,
} from "@/src/features/evals/v2/fns/evaluators/evaluatorAlertUrl";
import { MonitorSeverityBadge } from "@/src/features/monitors";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics";
import { renderEvaluatorAlertLastFired } from "@/src/features/evals/v2/fns/evaluators/renderEvaluatorAlertLastFired";
import { renderEvaluatorAlertTriggerCondition } from "@/src/features/evals/v2/fns/evaluators/renderEvaluatorAlertTriggerCondition";
// LITEFUSE ADDITION: the local `ConnectedAlert` shape reuses these two types.
import {
  metricAggregations,
  type MonitorThresholdOperator,
} from "@/src/features/evals/v2/constants/monitorContracts";
import type { z } from "zod/v4";

/**
 * LITEFUSE NOTE: upstream types this as
 * `RouterOutputs["monitors"]["linkedEvaluatorAlerts"]["data"][number]`. Litefuse
 * has no monitors router (decision M1 hides the evaluator-alert affordances), so
 * the row shape is declared locally from the fields this component and the two
 * render helpers actually read. `useEvaluatorAlerts` returns no alerts, so the
 * list is empty in practice; the type keeps the component honest if monitors
 * ever arrive.
 */
type ConnectedAlert = {
  id: string;
  name: string;
  severity: string;
  alertedAt: Date | null;
  metric: { measure: string; aggregation: z.infer<typeof metricAggregations> };
  thresholdOperator: MonitorThresholdOperator;
  alertThreshold: number;
};

type EvaluatorAlertButtonProps = {
  projectId: string;
  connectedAlerts: ConnectedAlert[];
  hasMore?: boolean;
  isLoading?: boolean;
  canRead: boolean;
  canCreate: boolean;
  limitReached?: boolean;
  /**
   * LITEFUSE ADDITION (decision M1): alerts are not available yet, so a surface
   * that has no connected alerts must not offer the *creation* entry point
   * (upstream's "Add alert" trigger + its create menu). Surfaces that do have
   * connected alerts keep the whole picker, so the connected list stays
   * reachable. Defaults to `false`: the component's own behaviour is unchanged
   * unless a caller opts in, which keeps the existing component tests honest.
   */
  hideCreateEntryWhenEmpty?: boolean;
} & (
  | {
      scope: "evaluator";
      evaluatorId: string;
      evaluatorType: EvalTemplateType;
      scoreDataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
    }
  | { scope: "allEvaluators" }
);

/** Alert picker for one evaluator or aggregate evaluator cost. */
export function EvaluatorAlertButton(props: EvaluatorAlertButtonProps) {
  const {
    projectId,
    connectedAlerts,
    hasMore = false,
    isLoading = false,
    canRead,
    canCreate,
    limitReached = false,
    hideCreateEntryWhenEmpty = false,
  } = props;
  const router = useRouter();
  const { t } = useTranslation();
  const capture = usePostHogClientCapture();
  const createDisabled = !canCreate || limitReached;
  const disabledReason = limitReached
    ? t("Alert limit reached")
    : t("You do not have permission to create alerts");
  const alertCount = connectedAlerts.length;
  const isAggregateCost = props.scope === "allEvaluators";
  const supportsCostAlert =
    isAggregateCost ||
    (props.scope === "evaluator" && props.evaluatorType === "LLM_AS_JUDGE");
  const scoreAlertUrl = (dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL") => {
    if (props.scope !== "evaluator") return "";
    return evaluatorAlertUrl(projectId, {
      type: "score",
      evaluatorId: props.evaluatorId,
      scoreDataType: dataType,
    });
  };
  const costAlertUrl = evaluatorAlertUrl(
    projectId,
    isAggregateCost
      ? { type: "allEvaluatorCost" }
      : { type: "cost", evaluatorId: props.evaluatorId },
  );
  const selectedScoreDataType =
    props.scope === "evaluator" ? props.scoreDataType : undefined;
  const navigate = (href: string, closePopover: () => void) => {
    closePopover();
    router.push(href).catch(() => undefined);
  };
  const openAlertCreation = (
    alertType: "score" | "cost" | "all_evaluator_cost",
    href: string,
    closePopover: () => void,
    dataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL",
  ) => {
    capture("evaluators:alert_create_clicked", {
      source: isAggregateCost ? "evaluator_overview" : "evaluator_detail",
      alertType,
      scoreDataType: dataType,
    });
    navigate(href, closePopover);
  };

  // M1: no connected alerts means there is nothing to list and nothing to
  // create, so the trigger (and its create menu) is not rendered at all. While
  // the alerts are still loading we cannot tell yet, so the trigger stays.
  if (hideCreateEntryWhenEmpty && !isLoading && alertCount === 0) {
    return null;
  }

  return (
    <PopoverController
      align="end"
      contentClassName="w-96 p-0"
      disabled={false}
      modal={false}
      renderContent={({ closePopover }) => (
        <Command defaultValue="__none__">
          <CommandList>
            {canRead && connectedAlerts.length > 0 ? (
              <div className="p-2">
                <p className="text-muted-foreground px-2 py-1.5 text-[10px] font-bold tracking-wider uppercase">
                  {t("Connected")} · {connectedAlerts.length}
                  {hasMore ? "+" : ""}
                </p>
                <div className="space-y-1">
                  {connectedAlerts.map((alert) => (
                    <CommandItem
                      key={alert.id}
                      value={`connected ${alert.name} ${alert.id}`}
                      className="items-start rounded-md px-3 py-2.5"
                      onSelect={() =>
                        navigate(
                          `/project/${projectId}/alerts/${alert.id}`,
                          closePopover,
                        )
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold" title={alert.name}>
                          {alert.name}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {renderEvaluatorAlertTriggerCondition(alert)}
                          <span className="px-1" aria-hidden="true">
                            ·
                          </span>
                          {renderEvaluatorAlertLastFired(alert.alertedAt)}
                        </p>
                      </div>
                      <MonitorSeverityBadge
                        severity={alert.severity}
                        className="ml-auto w-auto shrink-0 px-2 py-0.5 text-[10px]"
                      />
                      <ArrowUpRight className="text-muted-foreground h-4 w-4 shrink-0" />
                    </CommandItem>
                  ))}
                </div>
                {hasMore ? (
                  <CommandItem
                    value="see all alerts"
                    className="mt-1"
                    onSelect={() =>
                      navigate(
                        evaluatorAlertsListUrl(
                          projectId,
                          props.scope === "evaluator"
                            ? props.evaluatorId
                            : undefined,
                        ),
                        closePopover,
                      )
                    }
                  >
                    <span>{t("See all alerts")}</span>
                    <ArrowUpRight className="text-muted-foreground ml-auto h-4 w-4 shrink-0" />
                  </CommandItem>
                ) : null}
              </div>
            ) : (
              <div className="px-4 py-3">
                <p className="text-sm font-bold">
                  {isAggregateCost
                    ? t("No alerts on evaluator cost")
                    : t("No alerts on this evaluator")}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {isAggregateCost
                    ? t("Get notified when evaluator cost crosses a threshold.")
                    : supportsCostAlert
                      ? t(
                          "Get notified when this evaluator's scores or cost cross a threshold.",
                        )
                      : t(
                          "Get notified when this evaluator's score crosses a threshold.",
                        )}
                </p>
              </div>
            )}
            <CommandSeparator className="mx-0" />
            {connectedAlerts.length > 0 ? (
              <div className="flex items-center justify-between gap-3 p-2">
                <span className="text-muted-foreground flex h-8 items-center px-1 text-sm leading-none">
                  {t("Add alert")}
                </span>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {selectedScoreDataType ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 cursor-pointer gap-1.5"
                      disabled={createDisabled}
                      onClick={() =>
                        openAlertCreation(
                          "score",
                          scoreAlertUrl(selectedScoreDataType),
                          closePopover,
                          selectedScoreDataType,
                        )
                      }
                    >
                      <Gauge className="text-muted-foreground h-4 w-4" />
                      {t("Score")}
                    </Button>
                  ) : null}
                  {supportsCostAlert ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 cursor-pointer gap-1.5"
                      disabled={createDisabled}
                      onClick={() =>
                        openAlertCreation(
                          isAggregateCost ? "all_evaluator_cost" : "cost",
                          costAlertUrl,
                          closePopover,
                        )
                      }
                    >
                      <DollarSign className="text-muted-foreground h-4 w-4" />
                      {t("Cost")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <CommandGroup>
                {selectedScoreDataType ? (
                  <CommandItem
                    disabled={createDisabled}
                    onSelect={() =>
                      openAlertCreation(
                        "score",
                        scoreAlertUrl(selectedScoreDataType),
                        closePopover,
                        selectedScoreDataType,
                      )
                    }
                  >
                    <Gauge className="text-muted-foreground" />
                    <div>
                      <p>{t("Score threshold")}</p>
                      <p className="text-muted-foreground text-xs">
                        {t(
                          "Alert when this evaluator's score crosses a threshold",
                        )}
                      </p>
                    </div>
                    <ArrowUpRight className="text-muted-foreground ml-auto h-4 w-4 shrink-0" />
                  </CommandItem>
                ) : null}
                {supportsCostAlert ? (
                  <CommandItem
                    disabled={createDisabled}
                    onSelect={() =>
                      openAlertCreation(
                        isAggregateCost ? "all_evaluator_cost" : "cost",
                        costAlertUrl,
                        closePopover,
                      )
                    }
                  >
                    <DollarSign className="text-muted-foreground" />
                    <div>
                      <p>{t("Cost threshold")}</p>
                      <p className="text-muted-foreground text-xs">
                        {isAggregateCost
                          ? t("Alert when evaluator cost crosses a threshold")
                          : t("Alert on spend from running this evaluator")}
                      </p>
                    </div>
                    <ArrowUpRight className="text-muted-foreground ml-auto h-4 w-4 shrink-0" />
                  </CommandItem>
                ) : null}
              </CommandGroup>
            )}
            {createDisabled ? (
              <p className="text-muted-foreground px-3 pb-2 text-xs">
                {disabledReason}
              </p>
            ) : null}
          </CommandList>
        </Command>
      )}
    >
      {({ Trigger }) => (
        <Trigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={
              isLoading
                ? t("Loading evaluator alerts")
                : alertCount > 0
                  ? alertCount === 1
                    ? t("{{count}} connected evaluator alert", {
                        count: alertCount,
                      })
                    : t("{{count}} connected evaluator alerts", {
                        count: alertCount,
                      })
                  : t("Add evaluator alert")
            }
            className="w-auto max-w-full justify-start"
          >
            {isLoading ? (
              <LoaderCircle
                className="mr-1 h-4 w-4 shrink-0 animate-spin"
                aria-hidden="true"
              />
            ) : alertCount > 0 ? (
              <Bell className="mr-1 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <Plus className="mr-1 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span className="flex-1 text-left">
              {alertCount > 0 ? t("Alerts") : t("Add alert")}
            </span>
            {!isLoading && alertCount > 0 ? (
              <Badge variant="secondary" className="ml-1 shrink-0">
                {alertCount}
              </Badge>
            ) : null}
            <ChevronDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </Trigger>
      )}
    </PopoverController>
  );
}
