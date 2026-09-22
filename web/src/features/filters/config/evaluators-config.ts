import { evalConfigsTableCols } from "@/src/server/api/definitions/evalConfigsTable";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";

import { statusLabelKey } from "@/src/components/layouts/status-badge";
import { evaluatorTargetLabelKey } from "@/src/features/evals/utils/evaluator-form-utils";

import { i18nKey } from "@/src/features/i18n/i18nKey";
export const evaluatorFilterConfig: FilterConfig = {
  tableName: "evaluators",

  columnDefinitions: evalConfigsTableCols,

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
      type: "categorical" as const,
      column: "target",
      label: i18nKey("Target"),
      // The "Runs on" cell shows the same display name.
      formatLabel: evaluatorTargetLabelKey,
    },
  ],
};
