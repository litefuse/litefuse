/* eslint-disable no-nested-ternary */
import { useTranslation } from "react-i18next";

import { Tooltip } from "@/src/components/design-system/Tooltip/Tooltip";
import { cn } from "@/src/utils/tailwind";

/**
 * One marker per execution, oldest first, coloured by outcome. The evaluator
 * table feeds this from the evaluator's OWN execution traces
 * (`evalsV2.recentExecutions` → Doris `spans_<projectId>` grouped by
 * `metadata['evaluator_id']`), the rules table from the rule's own
 * `job_executions` runs.
 *
 * `statusMessage`/`durationMs` are optional so the rules table keeps working; when
 * present they turn a red marker into something explainable ("why did this run
 * fail").
 */
export function EvaluatorExecutionHistory({
  traces,
}: {
  traces: Array<{
    id: string;
    level: string;
    timestamp: Date;
    statusMessage?: string | null;
    durationMs?: number | null;
  }>;
}) {
  const { t } = useTranslation();

  if (traces.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">
        {t("No recent runs")}
      </span>
    );
  }

  const describe = (trace: {
    level: string;
    timestamp: Date;
    statusMessage?: string | null;
    durationMs?: number | null;
  }) => {
    const parts = [
      // `level` is the trace level enum the API returns (error, warning, ...),
      // so only the sentence around it is translated.
      t("{{level}} at {{timestamp}}", {
        level: trace.level.toLowerCase(),
        timestamp: trace.timestamp.toLocaleString(),
      }),
    ];
    if (typeof trace.durationMs === "number") {
      parts.push(t("took {{duration}} ms", { duration: trace.durationMs }));
    }
    if (trace.statusMessage) {
      parts.push(trace.statusMessage);
    }
    return parts.join(" — ");
  };

  return (
    <div
      className="flex items-center gap-1"
      role="img"
      aria-label={traces.map(describe).join(", ")}
    >
      {[...traces].reverse().map((trace) => (
        <Tooltip key={trace.id} label={describe(trace)}>
          {({ getTriggerProps }) => (
            <span
              {...getTriggerProps()}
              className={cn(
                "block h-4 w-1.5 rounded-full",
                trace.level === "ERROR"
                  ? "bg-destructive"
                  : trace.level === "WARNING"
                    ? "bg-dark-yellow"
                    : "bg-dark-green",
              )}
            />
          )}
        </Tooltip>
      ))}
    </div>
  );
}
