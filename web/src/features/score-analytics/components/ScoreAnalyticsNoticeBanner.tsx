import { Clock, Info } from "lucide-react";
import { useScoreAnalytics } from "./ScoreAnalyticsProvider";
import { useState, useEffect } from "react";
import { SamplingDetailsHoverCard } from "./SamplingDetailsHoverCard";

import { useTranslation } from "react-i18next";
export function ScoreAnalyticsNoticeBanner() {
  const { t } = useTranslation();
  const { isEstimating, estimate, isLoading, data } = useScoreAnalytics();
  const [showLoadingBanner, setShowLoadingBanner] = useState(false);

  // Track when estimation starts and set delay for showing loading banner
  useEffect(() => {
    if (isEstimating || (estimate && isLoading)) {
      // Start timer - show banner after 1.5 seconds
      const timer = setTimeout(() => {
        setShowLoadingBanner(true);
      }, 1500);

      return () => clearTimeout(timer);
    } else {
      // Reset when loading completes
      setShowLoadingBanner(false);
    }
  }, [isEstimating, estimate, isLoading]);

  // Don't show anything if we haven't started
  if (!isEstimating && !estimate) return null;

  // State 1: Estimating (loading)
  if (isEstimating || (estimate && isLoading)) {
    const showLargeDataset =
      estimate && estimate.estimatedMatchedCount > 100_000;

    // Only show banner if:
    // 1. Delay has passed, OR
    // 2. We have estimate data showing it's a large dataset
    if (!showLoadingBanner && !showLargeDataset) {
      return null;
    }

    return (
      <div className="bg-muted mb-4 rounded-md px-4 py-3">
        <div className="flex items-start gap-3">
          <Clock className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="text-sm font-medium">
              {showLargeDataset
                ? t("Processing large dataset...")
                : t("Loading analytics...")}
            </div>
            {estimate && (
              <div className="text-muted-foreground text-sm">
                {estimate.mode === "single"
                  ? t("Analyzing ~{{total}} scores", {
                      total: estimate.score1Count.toLocaleString(),
                    })
                  : t(
                      "Analyzing ~{{first}} (Score 1) and ~{{second}} (Score 2) scores",
                      {
                        first: estimate.score1Count.toLocaleString(),
                        second: estimate.score2Count.toLocaleString(),
                      },
                    )}
                {estimate.willSample && ` ${t("• Sampling will be applied")}`}
                {estimate.estimatedQueryTime &&
                  ` ${t("• Est. time: {{time}}", {
                    time: estimate.estimatedQueryTime,
                  })}`}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // State 2: Loaded with sampling
  if (data?.samplingMetadata.isSampled) {
    return (
      <div className="bg-muted mb-4 rounded-md px-4 py-3">
        <div className="flex items-start gap-3">
          <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              {t("Sampled Data")}
              <SamplingDetailsHoverCard
                samplingMetadata={data.samplingMetadata}
                mode={data.metadata.mode}
              />
            </div>
            <div className="text-muted-foreground text-sm">
              {data.metadata.mode === "single"
                ? `Results based on a ${(data.samplingMetadata.samplingRate * 100).toFixed(2)}% sample of ~${data.samplingMetadata.preflightEstimates?.score1Count.toLocaleString()} scores.`
                : `Results based on a ${(data.samplingMetadata.samplingRate * 100).toFixed(2)}% sample of ~${data.samplingMetadata.preflightEstimates?.score1Count.toLocaleString()} Score 1 and ~${data.samplingMetadata.preflightEstimates?.score2Count.toLocaleString()} Score 2 data.`}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // State 3: Loaded without sampling (don't show banner)
  return null;
}
