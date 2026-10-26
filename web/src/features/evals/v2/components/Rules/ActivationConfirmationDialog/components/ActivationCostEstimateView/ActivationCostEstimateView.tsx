// LITEFUSE: cost-estimate UI is hidden in this fork (see
// `RuleEvaluatorCostEstimate`). The per-evaluator weekly cost and the summed
// "estimated LLM costs / week" footer rendered `≈ $0.00` / "Unavailable"
// because the test-run cost is never computed, so this view renders nothing.
// The activation dialog keeps its description and sampling slider, which the
// rule activation flow still needs.
export function ActivationCostEstimateView({
  estimates: _estimates,
}: {
  estimates: Array<{
    evaluatorId: string;
    evaluatorName: string;
    matchingObservations: number;
    sampling: number;
    testRunCostUsd: number;
    estimatedCostUsd: number;
  }>;
}) {
  return null;
}
