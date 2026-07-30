import { useQueryParams, StringParam, withDefault } from "use-query-params";
import {
  type DashboardDateRangeAggregationOption,
  DEFAULT_DASHBOARD_AGGREGATION_SELECTION,
  DASHBOARD_AGGREGATION_OPTIONS,
  rangeToString,
  rangeFromString,
  getAbbreviatedTimeRange,
  clampDashboardTimeRangeToLookbackLimit,
  type TimeRange,
} from "@/src/utils/date-range-utils";
import { useMemo } from "react";
import { useEntitlementLimit } from "@/src/features/entitlements/hooks";

export interface UseDashboardDateRangeOutput {
  timeRange: TimeRange;
  setTimeRange: (timeRange: TimeRange) => void;
}

export function useDashboardDateRange(
  options: {
    defaultRelativeAggregation?: DashboardDateRangeAggregationOption;
  } = {},
): UseDashboardDateRangeOutput {
  const fallbackAggregation =
    options.defaultRelativeAggregation ??
    DEFAULT_DASHBOARD_AGGREGATION_SELECTION;
  const lookbackLimit = useEntitlementLimit("data-access-days");

  const [queryParams, setQueryParams] = useQueryParams({
    dateRange: withDefault(
      StringParam,
      getAbbreviatedTimeRange(fallbackAggregation),
    ),
  });

  return useMemo(() => {
    const timeRange = clampDashboardTimeRangeToLookbackLimit(
      rangeFromString(
        queryParams.dateRange,
        DASHBOARD_AGGREGATION_OPTIONS,
        fallbackAggregation,
      ),
      lookbackLimit,
    );

    const setTimeRange = (timeRange: TimeRange) => {
      setQueryParams({
        dateRange: rangeToString(
          clampDashboardTimeRangeToLookbackLimit(timeRange, lookbackLimit),
        ),
      });
    };

    return {
      timeRange,
      setTimeRange,
    };
  }, [
    queryParams.dateRange,
    fallbackAggregation,
    lookbackLimit,
    setQueryParams,
  ]);
}
