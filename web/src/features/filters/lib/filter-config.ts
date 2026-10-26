import type React from "react";
import type { ColumnDefinition } from "@langfuse/shared";

interface BaseFacet {
  column: string;
  label: string;
  tooltip?: string;
  isDisabled?: boolean;
  disabledReason?: string;
  // Mutually exclusive with these facet columns. If both are active,
  // the last added filter wins and the other facet is disabled.
  mutuallyExclusiveWith?: string[];
}

interface CategoricalFacet extends BaseFacet {
  type: "categorical";
  /** Optional function to render an icon next to filter option labels */
  renderIcon?: (value: string) => React.ReactNode;
  /**
   * Optional map from a raw option value to the i18n key of its label. Only
   * for columns whose values are internal enums that the table cells already
   * render as labels; values that also travel over the API stay verbatim.
   */
  formatLabel?: (value: string) => string;
}

interface BooleanFacet extends BaseFacet {
  type: "boolean";
  trueLabel?: string;
  falseLabel?: string;
  invertValue?: boolean; // When true, "True" label maps to filter value=false, used for parent_observation_id filter for is Root?
}

interface NumericFacet extends BaseFacet {
  type: "numeric";
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

interface StringFacet extends BaseFacet {
  type: "string";
}

interface KeyValueFacet extends BaseFacet {
  type: "keyValue";
  keyOptions?: string[];
}

interface NumericKeyValueFacet extends BaseFacet {
  type: "numericKeyValue";
  keyOptions?: string[];
}

interface StringKeyValueFacet extends BaseFacet {
  type: "stringKeyValue";
  keyOptions?: string[];
}

interface PositionInTraceFacet extends BaseFacet {
  type: "positionInTrace";
}

export type Facet =
  | CategoricalFacet
  | BooleanFacet
  | NumericFacet
  | StringFacet
  | KeyValueFacet
  | NumericKeyValueFacet
  | StringKeyValueFacet
  | PositionInTraceFacet;

export interface FilterConfig {
  tableName: string;
  columnDefinitions: ColumnDefinition[];
  defaultExpanded?: string[];
  defaultSidebarCollapsed?: boolean;
  facets: Facet[];
  /**
   * LITEFUSE ADDITION. Column ids this surface accepts from a URL/saved view but
   * filters on under a different (canonical) column id. Used when a deep link
   * emits a backend-alias id that this surface exposes under its own column —
   * e.g. the evaluators/rules "last runs" links emit `traceName`, which the
   * traces surface exposes as `name` (both are `trace_name` in the Doris
   * mapping). Rewriting keeps the filter visible in the sidebar instead of
   * applying an invisible filter.
   */
  columnAliases?: Record<string, string>;
  /**
   * LITEFUSE ADDITION. Column ids this surface recognises but cannot apply to
   * its own query, mapped to a human-readable reason. Such a filter is dropped
   * with an explicit message naming the column and the reason, instead of the
   * generic "unknown filter column" warning — the ids arrive from our own deep
   * links, and the surface is expected to ignore them. Keeping them out of
   * `columnDefinitions` is deliberate: an id without a backend column mapping
   * makes the Doris query builder throw
   * (`matchAndVerifyTracesUiColumn` in queries/doris-sql/factory.ts).
   */
  unappliedFilterColumns?: Record<string, string>;
}
