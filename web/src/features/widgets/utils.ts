import startCase from "lodash/startCase";
import { type FilterState } from "@langfuse/shared";
import { type DashboardWidgetChartType } from "@langfuse/shared/src/db";
import { type TFunction } from "i18next";

import {
  aggregationLabelKey,
  dataModelLabelKey,
} from "@/src/features/widgets/lib/dataModelLabels";
import { i18nKey } from "@/src/features/i18n/i18nKey";

// Shared widget chart configuration types
export type WidgetChartConfig = {
  type: DashboardWidgetChartType;
  row_limit?: number;
  bins?: number;
  defaultSort?: {
    column: string;
    order: "ASC" | "DESC";
  };
};

/** View names are query identifiers; these are the labels shown for them. */
const VIEW_LABELS: Record<string, string> = {
  traces: i18nKey("Traces"),
  observations: i18nKey("Observations"),
  "scores-numeric": i18nKey("Scores (numeric)"),
  "scores-categorical": i18nKey("Scores (categorical)"),
};

export function viewLabelKey(view: string): string {
  return VIEW_LABELS[view] ?? startCase(view);
}

/**
 * Formats a metric name for display, handling special cases like count_count -> Count
 */
export function formatMetricName(metricName: string, t: TFunction): string {
  // Handle the count_count -> Count conversion
  if (metricName === "count_count") return t(aggregationLabelKey("count"));
  return t(dataModelLabelKey(metricName));
}

/**
 * Formats multiple metric names for display, showing first 3 and "+ X more" if needed
 */
export function formatMultipleMetricNames(
  metricNames: string[],
  t: TFunction,
): string {
  if (metricNames.length === 0) return t("No Metrics");
  if (metricNames.length === 1) return formatMetricName(metricNames[0], t);

  const formattedNames = metricNames.map((name) => formatMetricName(name, t));
  const joinList = (names: string[]) =>
    names.reduce((left, right) => t("{{left}}, {{right}}", { left, right }));

  if (metricNames.length <= 3) {
    return joinList(formattedNames);
  }

  return t("{{names}} + {{total}} more", {
    names: joinList(formattedNames.slice(0, 3)),
    total: metricNames.length - 3,
  });
}

/** The measure part of the generated name, e.g. "Avg Latency" or "Count". */
function buildMeasureLabel({
  aggregation,
  measure,
  metrics,
  isMultiMetric,
  t,
}: {
  aggregation: string;
  measure: string;
  metrics?: string[];
  isMultiMetric: boolean;
  t: TFunction;
}): string {
  if (isMultiMetric && metrics && metrics.length > 0) {
    return formatMultipleMetricNames(metrics, t);
  }
  const measureLabel = formatMetricName(measure, t);
  // For count measures, the aggregation is implied by the measure.
  if (measure.toLowerCase() === "count") return measureLabel;
  return t("{{aggregation}} {{measure}}", {
    aggregation: t(aggregationLabelKey(aggregation)),
    measure: measureLabel,
  });
}

/** Joins the dimensions of a pivot table into one label. */
function buildDimensionLabel(dimensions: string[], t: TFunction): string {
  const labels = dimensions.map((d) => t(dataModelLabelKey(d)));
  if (labels.length <= 1) return labels[0] ?? "";
  return labels.reduce((left, right) =>
    t("{{left}} and {{right}}", { left, right }),
  );
}

export function buildWidgetName({
  aggregation,
  measure,
  dimensions,
  view,
  metrics,
  isMultiMetric = false,
  t,
}: {
  aggregation: string;
  measure: string;
  dimensions: string[];
  view: string;
  metrics?: string[];
  isMultiMetric?: boolean;
  t: TFunction;
}) {
  const metric = buildMeasureLabel({
    aggregation,
    measure,
    metrics,
    isMultiMetric,
    t,
  });
  const viewLabel = t(viewLabelKey(view));

  if (dimensions.length > 0) {
    return t("{{metric}} by {{dimension}} ({{view}})", {
      metric,
      dimension: buildDimensionLabel(dimensions, t),
      view: viewLabel,
    });
  }
  return t("{{metric}} ({{view}})", { metric, view: viewLabel });
}

export function buildWidgetDescription({
  aggregation,
  measure,
  dimensions,
  view,
  filters,
  metrics,
  isMultiMetric = false,
  t,
}: {
  aggregation: string;
  measure: string;
  dimensions: string[];
  view: string;
  filters: FilterState;
  metrics?: string[];
  isMultiMetric?: boolean;
  t: TFunction;
}) {
  const metric = buildMeasureLabel({
    aggregation,
    measure,
    metrics,
    isMultiMetric,
    t,
  });
  const viewLabel = t(viewLabelKey(view));

  let sentence =
    dimensions.length > 0
      ? t("Shows {{metric}} of {{view}} by {{dimension}}", {
          metric,
          view: viewLabel,
          dimension: buildDimensionLabel(dimensions, t),
        })
      : t("Shows {{metric}} of {{view}}", { metric, view: viewLabel });

  if (filters && filters.length > 0) {
    sentence =
      filters.length <= 2
        ? t("{{sentence}}, filtered by {{columns}}", {
            sentence,
            columns: buildDimensionLabel(
              filters.map((f) => f.column),
              t,
            ),
          })
        : t("{{sentence}}, filtered by {{total}} conditions", {
            sentence,
            total: filters.length,
          });
  }

  return sentence;
}

/**
 * Returns the default view for the new widget form.
 * When v4 beta is enabled, defaults to "observations" because "traces"
 * is excluded from viewsV2 (no v2-specific API support).
 */
export function getDefaultView(
  isBetaEnabled: boolean,
): "traces" | "observations" {
  return isBetaEnabled ? "observations" : "traces";
}
