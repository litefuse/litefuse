import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/src/utils/tailwind";
import {
  RESOURCE_LIMIT_ERROR_MESSAGE,
  SLOW_QUERY_HINT_TEXT,
} from "@langfuse/shared";
import { useTranslation } from "react-i18next";

const DEFAULT_HINT_DELAY_MS = 2000;

type ChartLoadingStateProps = {
  isLoading: boolean;
  className?: string;
  spinnerClassName?: string;
  hintClassName?: string;
  spinnerLabel?: string;
  hintText?: string;
  hintDelayMs?: number;
  showSpinner?: boolean;
  showHintImmediately?: boolean;
};

export function ChartLoadingState({
  isLoading,
  className,
  spinnerClassName,
  hintClassName,
  spinnerLabel,
  hintText = SLOW_QUERY_HINT_TEXT,
  hintDelayMs = DEFAULT_HINT_DELAY_MS,
  showSpinner = true,
  showHintImmediately = false,
}: ChartLoadingStateProps) {
  const { t } = useTranslation();
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShowHint(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShowHint(true);
    }, hintDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [hintDelayMs, isLoading]);

  if (!isLoading) {
    return null;
  }

  const shouldShowHint = showHintImmediately || showHint;
  const displayHintText =
    hintText === SLOW_QUERY_HINT_TEXT
      ? t(
          "This query is taking longer than usual. Try reducing the time frame or adding more filters.",
        )
      : hintText === RESOURCE_LIMIT_ERROR_MESSAGE
        ? t(
            "Your query could not be completed. Please narrow your request by adding more specific filters (e.g., a shorter date range).",
          )
        : hintText;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={spinnerLabel ?? t("Loading chart data")}
      className={cn(
        "text-muted-foreground flex flex-col items-center justify-center gap-2",
        className,
      )}
    >
      <div className="flex h-4 w-4 items-center justify-center">
        {showSpinner ? (
          <Loader2 className={cn("h-4 w-4 animate-spin", spinnerClassName)} />
        ) : (
          <span className="h-4 w-4" aria-hidden="true" />
        )}
      </div>
      {shouldShowHint ? (
        <p
          className={cn(
            "animate-in fade-in-0 max-w-xs text-center text-xs duration-300",
            hintClassName,
          )}
        >
          {displayHintText}
        </p>
      ) : null}
    </div>
  );
}
