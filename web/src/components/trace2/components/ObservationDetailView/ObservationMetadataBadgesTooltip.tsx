/**
 * Tooltip-based metadata badges for ObservationDetailView
 * These badges use BreakdownTooltip to show detailed cost/usage information
 */

import { type ObservationType, isGenerationLike } from "@langfuse/shared";
import { Badge } from "@/src/components/ui/badge";
import { BreakdownTooltip } from "@/src/components/trace2/components/_shared/BreakdownToolTip";
import { usdFormatter, formatTokenCounts } from "@/src/utils/numbers";
import { InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

export function CostBadge({
  totalCost,
  costDetails,
}: {
  totalCost: number | null;
  costDetails: Record<string, number> | undefined;
}) {
  // Don't show if no cost data or cost is 0
  if (totalCost == null || totalCost === 0 || !costDetails) return null;

  return (
    <BreakdownTooltip details={costDetails} isCost={true}>
      <Badge variant="tertiary" className="flex items-center gap-1">
        <span>{usdFormatter(totalCost)}</span>
        <InfoIcon className="h-3 w-3" />
      </Badge>
    </BreakdownTooltip>
  );
}

export function UsageBadge({
  type,
  inputUsage,
  outputUsage,
  totalUsage,
  usageDetails,
}: {
  type: ObservationType;
  inputUsage: number;
  outputUsage: number;
  totalUsage: number;
  usageDetails: Record<string, number> | undefined;
}) {
  const { t } = useTranslation();

  // Only show for generation-like observations
  if (!isGenerationLike(type) || !usageDetails) return null;

  const tokenText = formatTokenCounts(
    inputUsage,
    outputUsage,
    totalUsage,
    true,
    t,
  );
  const hasText = tokenText.length > 0;

  return (
    <BreakdownTooltip details={usageDetails} isCost={false}>
      <Badge
        variant="tertiary"
        className={`flex items-center gap-1 ${!hasText ? "h-6 pl-2" : ""}`}
      >
        {hasText && <span>{tokenText}</span>}
        <InfoIcon className="h-3 w-3" />
      </Badge>
    </BreakdownTooltip>
  );
}
