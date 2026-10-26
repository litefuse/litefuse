// ── LITEFUSE NOTE (authored file, not upstream code) ────────────────────────
// \`renderEvaluatorAlertTriggerCondition\` imports two things we cannot resolve:
//
//   - \`MonitorThresholdOperator\` from \`@langfuse/shared/monitors\` — a subpath our
//     shared package does not export (there is no monitors feature here)
//   - \`metricAggregations\` from \`@langfuse/shared\` — declared upstream in
//     \`packages/shared/src/features/query/types.ts\`, a module our fork predates
//
// Both are small, self-contained contracts, so they are declared here rather than
// editing \`@langfuse/shared\` (outside the evaluator module) or adding an export
// subpath to it. Values are copied verbatim from upstream.
//
// Replacement suggestion (step-3 reconciliation): if other features ever need
// \`metricAggregations\`, promote it to shared and delete the copy here.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod/v4";

export const metricAggregations = z.enum([
  "sum",
  "avg",
  "count",
  "max",
  "min",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "histogram",
  "uniq",
]);

export type MonitorThresholdOperator = "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ";
