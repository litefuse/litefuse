import { evalExecutionsFilterCols } from "@/src/server/api/definitions/evalExecutionsTable";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";

import { statusLabelKey } from "@/src/components/layouts/status-badge";

import { i18nKey } from "@/src/features/i18n/i18nKey";
export const evalLogFilterConfig: FilterConfig = {
  tableName: "evalLogs",

  columnDefinitions: evalExecutionsFilterCols,

  defaultExpanded: ["status"],

  defaultSidebarCollapsed: true,

  facets: [
    {
      type: "categorical" as const,
      column: "status",
      label: i18nKey("Status"),
      // The status cell is a StatusBadge, so the options read the same way.
      formatLabel: statusLabelKey,
    },
    {
      type: "string" as const,
      column: "traceId",
      label: i18nKey("Trace ID"),
    },
    {
      type: "string" as const,
      column: "sessionId",
      label: i18nKey("Session ID"),
    },
    {
      type: "string" as const,
      column: "executionTraceId",
      label: i18nKey("Execution Trace ID"),
    },
    {
      type: "numeric" as const,
      column: "scoreValue",
      label: i18nKey("Score Value"),
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],
};
