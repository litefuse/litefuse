import { promptsTableCols } from "@langfuse/shared";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";

import { i18nKey } from "@/src/features/i18n/i18nKey";
export const promptFilterConfig: FilterConfig = {
  tableName: "prompts",

  columnDefinitions: promptsTableCols,

  defaultExpanded: ["type"],

  defaultSidebarCollapsed: true,

  facets: [
    {
      type: "categorical" as const,
      column: "type",
      label: i18nKey("Type"),
    },
    {
      type: "categorical" as const,
      column: "labels",
      label: i18nKey("Labels"),
    },
    {
      type: "categorical" as const,
      column: "tags",
      label: i18nKey("Tags"),
    },
    {
      type: "numeric" as const,
      column: "version",
      label: i18nKey("Version"),
      min: 1,
      max: 100,
    },
  ],
};
