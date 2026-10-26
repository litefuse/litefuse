/* eslint-disable no-nested-ternary */
import { Trans, useTranslation } from "react-i18next";

import { Slider } from "@/src/components/ui/slider";
import { InfoTooltip } from "@/src/components/ui/InfoTooltip/InfoTooltip";
import {
  SAMPLING_SLIDER_MIN,
  SAMPLING_SLIDER_STEP,
} from "@/src/features/evals/v2/constants/ruleSampling";
import type { ActivationEstimate } from "@/src/features/evals/v2/fns/requestRuleActivation";
import { compactNumberFormatter } from "@/src/utils/numbers";

export function ActivationCostEstimateDetails({
  estimates: baseEstimates,
  unavailableEstimateCount,
  matchingObservations,
  sampling,
  onSamplingChange,
  descriptionAsTooltip = false,
}: {
  estimates: ActivationEstimate[];
  unavailableEstimateCount: number;
  matchingObservations: number;
  sampling: number;
  onSamplingChange?: (sampling: number) => void;
  descriptionAsTooltip?: boolean;
}) {
  const { t } = useTranslation();
  const hasNoMatchingObservations = matchingObservations === 0;
  const hasOnlyUnavailableEstimates =
    baseEstimates.length === 0 && unavailableEstimateCount > 0;
  const sampledObservations = Math.round(matchingObservations * sampling);
  // LITEFUSE: the cost-estimate rows/summary are hidden (the test-run cost is
  // never computed in this fork), so the per-evaluator `estimates` projection is
  // gone; the observation-count wording and the sampling slider stay.
  const hasEstimates = baseEstimates.length > 0;
  const description = hasNoMatchingObservations
    ? t(
        "No observations matched this rule in the last 7 days, so there is nothing to estimate yet. It will evaluate matching observations as they arrive.",
      )
    : hasOnlyUnavailableEstimates
      ? t(
          "Activating this rule may incur costs. Are you sure you want to continue?",
        )
      : t(
          "{{observationCount}} observations matched this rule in the last 7 days.",
          {
            observationCount: compactNumberFormatter(matchingObservations, 1),
          },
        );

  return (
    <div className="flex flex-col gap-4">
      {descriptionAsTooltip ? (
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-bold">{t("Cost estimation")}</p>
            <InfoTooltip label={t("About cost estimation")}>
              {description}
            </InfoTooltip>
          </div>
          <p className="text-muted-foreground text-sm">
            {t(
              "Review the expected cost before running this evaluator automatically.",
            )}
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}

      {hasEstimates ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-bold">{t("Sampling rate")}</p>
            <InfoTooltip label={t("About sampling rate")}>
              {t(
                "The percentage of matching observations that will be evaluated. Lower sampling rates reduce evaluation volume and cost.",
              )}
            </InfoTooltip>
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
          <p className="text-muted-foreground text-xs">
            {baseEstimates.length === 1 ? (
              <Trans
                i18nKey="This evaluator would run on <0>{{sampledCount}}</0> of the {{matchingCount}} matching observations."
                values={{
                  sampledCount: compactNumberFormatter(sampledObservations, 1),
                  matchingCount: compactNumberFormatter(
                    matchingObservations,
                    1,
                  ),
                }}
                components={[
                  <span
                    key="sampledCount"
                    className="text-foreground font-bold tabular-nums"
                  />,
                ]}
              />
            ) : (
              <Trans
                i18nKey="Each evaluator would run on <0>{{sampledCount}}</0> of the {{matchingCount}} matching observations."
                values={{
                  sampledCount: compactNumberFormatter(sampledObservations, 1),
                  matchingCount: compactNumberFormatter(
                    matchingObservations,
                    1,
                  ),
                }}
                components={[
                  <span
                    key="sampledCount"
                    className="text-foreground font-bold tabular-nums"
                  />,
                ]}
              />
            )}
          </p>
        </div>
      ) : null}
    </div>
  );
}
