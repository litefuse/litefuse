// LITEFUSE: cost-estimate UI is hidden in this fork.
//
// `getLatestEvaluatorRunCost` always returns null and the test-run cost is left
// unset by decision L1 (web/src/features/evals/v2/server/evaluators/testEvaluator.ts),
// so every caller of this component rendered an "Unavailable" / "≈ $0.00 / week"
// label — a blank or actively misleading value. Rather than show it, the
// component renders nothing. Kept as a component (instead of deleting every call
// site) so the surrounding rule-setup and activation layouts are untouched.
import type { RuleCostEstimate } from "@/src/features/evals/v2/hooks/useRuleCostEstimate";

export function RuleEvaluatorCostEstimate({
  estimate: _estimate,
}: {
  estimate: RuleCostEstimate;
}) {
  return null;
}
