import { startCase } from "lodash";
import type { z } from "zod/v4";

import {
  metricAggregations,
  type MonitorThresholdOperator,
} from "@/src/features/evals/v2/constants/monitorContracts";

const operatorSymbol: Record<MonitorThresholdOperator, string> = {
  GT: ">",
  GTE: "≥",
  LT: "<",
  LTE: "≤",
  EQ: "=",
  NEQ: "≠",
};

const aggregationLabel = (
  aggregation: z.infer<typeof metricAggregations>,
): string =>
  /^p\d+$/.test(aggregation) ? aggregation : startCase(aggregation);

/** Renders an evaluator alert boundary, e.g. "Count > 5". */
export function renderEvaluatorAlertTriggerCondition({
  metric,
  thresholdOperator,
  alertThreshold,
}: {
  metric: { measure: string; aggregation: z.infer<typeof metricAggregations> };
  thresholdOperator: MonitorThresholdOperator;
  alertThreshold: number;
}): string {
  const metricLabel =
    metric.measure === "count"
      ? "Count"
      : `${aggregationLabel(metric.aggregation)} ${startCase(metric.measure).toLowerCase()}`;

  return `${metricLabel} ${operatorSymbol[thresholdOperator]} ${alertThreshold}`;
}
