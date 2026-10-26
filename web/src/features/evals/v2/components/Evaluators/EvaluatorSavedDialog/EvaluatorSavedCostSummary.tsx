/* eslint-disable no-nested-ternary */
import { EvalTemplateType, EvalTemplateTypeEnum } from "@langfuse/shared";
import { useTranslation } from "react-i18next";

import { InfoTooltip } from "@/src/components/ui/InfoTooltip/InfoTooltip";
import { Skeleton } from "@/src/components/ui/skeleton";
import { Slider } from "@/src/components/ui/slider";
import {
  SAMPLING_SLIDER_MIN,
  SAMPLING_SLIDER_STEP,
} from "@/src/features/evals/v2/constants/ruleSampling";
import type { ActivationEstimate } from "@/src/features/evals/v2/fns/requestRuleActivation";
import { compactNumberFormatter } from "@/src/utils/numbers";

/**
 * LITEFUSE: the cost-estimate half of this summary is hidden.
 *
 * The test-run cost is not computed in this fork (`testEvaluator` leaves
 * `estimatedCostUsd` unset and `getLatestEvaluatorRunCost` always returns null),
 * so the "Recurring ≈ $…" and "One-time backfill ≈ $…" sections could only ever
 * render `≈ $0.00` or "Unavailable" — a misleading value. The sampling slider and
 * the code-evaluator "Matches" section are untouched, so saving an evaluator
 * behaves exactly as before.
 *
 * The `estimates`, `unavailableEstimateCount` and `backfill` props are kept in
 * the type because the dialog still passes them; they are intentionally unread.
 */
export function EvaluatorSavedCostSummary({
  matchingObservations,
  sampling,
  isEstimating,
  onSamplingChange,
  evaluatorType,
}: {
  estimates: ActivationEstimate[];
  unavailableEstimateCount: number;
  matchingObservations: number;
  sampling: number;
  isEstimating: boolean;
  onSamplingChange: ((sampling: number) => void) | null;
  evaluatorType: EvalTemplateType;
  backfill:
    | { enabled: false }
    | {
        enabled: true;
        matchingObservations: number;
        maxItems: number;
        testRunCostUsd: number | null;
        isEstimating: boolean;
      };
}) {
  const { t } = useTranslation();
  const sampledObservations = Math.round(matchingObservations * sampling);

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-bold">{t("Sampling")}</h3>
          {!onSamplingChange ? (
            <InfoTooltip label={t("Sampling is set by the selected rule")}>
              {t(
                "The sampling rate is inherited from the selected rule. You can edit it directly in the rule.",
              )}
            </InfoTooltip>
          ) : null}
        </div>
        <Slider
          min={SAMPLING_SLIDER_MIN}
          max={1}
          step={SAMPLING_SLIDER_STEP}
          value={[sampling]}
          showInput
          displayAsPercentage
          disabled={!onSamplingChange}
          onValueChange={(value) => onSamplingChange?.(value[0] ?? sampling)}
        />
      </section>

      {evaluatorType === EvalTemplateTypeEnum.CODE ? (
        <section>
          <h3 className="text-sm font-bold">{t("Matches")}</h3>
          {isEstimating ? (
            <div className="mt-2 space-y-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          ) : (
            <>
              <p className="mt-1 font-mono text-base font-bold tabular-nums">
                {t("{{value}} / week", {
                  value: compactNumberFormatter(matchingObservations, 1),
                })}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {t("{{value}} sampled", {
                  value: compactNumberFormatter(sampledObservations, 1),
                })}
              </p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
