import { NoDataOrLoading } from "@/src/components/NoDataOrLoading";
import { DashboardCard } from "@/src/features/dashboard/components/cards/DashboardCard";
import {
  extractTimeSeriesData,
  fillMissingValuesAndTransform,
  isEmptyTimeSeries,
} from "@/src/features/dashboard/components/hooks";
import { TabComponent } from "@/src/features/dashboard/components/TabsComponent";
import { TotalMetric } from "@/src/features/dashboard/components/TotalMetric";
import { totalCostDashboardFormatted } from "@/src/features/dashboard/lib/dashboard-utils";
import {
  type DashboardDateRangeAggregationOption,
  dashboardDateRangeAggregationSettings,
} from "@/src/utils/date-range-utils";
import { compactNumberFormatter } from "@/src/utils/numbers";
import { type FilterState, getGenerationLikeTypes } from "@langfuse/shared";
import {
  ModelSelectorPopover,
  useModelSelection,
} from "@/src/features/dashboard/components/ModelSelector";
import {
  type QueryType,
  type ViewVersion,
  mapLegacyUiTableFilterToView,
} from "@/src/features/query";
import { type DatabaseRow } from "@/src/server/api/services/sqlInterface";
import { Chart } from "@/src/features/widgets/chart-library/Chart";
import { timeSeriesToDataPoints } from "@/src/features/dashboard/lib/chart-data-adapters";
import { useScheduledDashboardExecuteQuery } from "@/src/hooks/useDashboardQueryScheduler";

export const ModelUsageChart = ({
  className,
  projectId,
  globalFilterState,
  agg,
  fromTimestamp,
  toTimestamp,
  userAndEnvFilterState,
  isLoading = false,
  metricsVersion,
  schedulerId,
}: {
  className?: string;
  projectId: string;
  globalFilterState: FilterState;
  agg: DashboardDateRangeAggregationOption;
  fromTimestamp: Date;
  toTimestamp: Date;
  userAndEnvFilterState: FilterState;
  isLoading?: boolean;
  metricsVersion?: ViewVersion;
  schedulerId?: string;
}) => {
  const {
    allModels,
    selectedModels,
    setSelectedModels,
    isAllSelected,
    buttonText,
    handleSelectAll,
  } = useModelSelection(
    projectId,
    userAndEnvFilterState,
    fromTimestamp,
    toTimestamp,
    metricsVersion,
    {
      enabled: !isLoading,
      queryId: `${schedulerId ?? "home:model-usage"}:all-models`,
    },
  );
  const hasModelSelection = selectedModels.length > 0 && allModels.length > 0;
  const isModelUsageEnabled = !isLoading && hasModelSelection;

  const modelUsageQuery: QueryType = {
    view: "observations",
    dimensions: [{ field: "providedModelName" }],
    metrics: [
      { measure: "totalCost", aggregation: "sum" },
      { measure: "totalTokens", aggregation: "sum" },
    ],
    filters: [
      ...mapLegacyUiTableFilterToView("observations", userAndEnvFilterState),
      {
        column: "type",
        operator: "any of",
        value: getGenerationLikeTypes(),
        type: "stringOptions",
      },
      {
        column: "providedModelName",
        operator: "any of",
        value: selectedModels,
        type: "stringOptions",
      },
    ],
    timeDimension: {
      granularity:
        dashboardDateRangeAggregationSettings[agg].dateTrunc ?? "day",
    },
    fromTimestamp: fromTimestamp.toISOString(),
    toTimestamp: toTimestamp.toISOString(),
    orderBy: null,
  };

  const queryResult = useScheduledDashboardExecuteQuery(
    {
      projectId,
      query: modelUsageQuery,
      version: metricsVersion,
    },
    {
      enabled: isModelUsageEnabled,
      trpc: {
        context: {
          skipBatch: true,
        },
      },
      queryId: `${schedulerId ?? "home:model-usage"}:timeseries`,
      priority: 1001,
    },
  );

  // "by type" queries: use the same useScheduledDashboardExecuteQuery path
  // as "by model" so that Doris fillTimeSeriesGaps + fillMissingValuesAndTransform
  // produce a continuous X-axis over the full time range.
  const costByTypeQuery: QueryType = {
    view: "observations",
    dimensions: [{ field: "costType" }],
    metrics: [{ measure: "costByType", aggregation: "sum" }],
    filters: [
      ...mapLegacyUiTableFilterToView("observations", userAndEnvFilterState),
      {
        column: "type",
        operator: "any of",
        value: getGenerationLikeTypes(),
        type: "stringOptions",
      },
      {
        column: "providedModelName",
        operator: "any of",
        value: selectedModels,
        type: "stringOptions",
      },
    ],
    timeDimension: {
      granularity:
        dashboardDateRangeAggregationSettings[agg].dateTrunc ?? "day",
    },
    fromTimestamp: fromTimestamp.toISOString(),
    toTimestamp: toTimestamp.toISOString(),
    orderBy: null,
  };

  const queryCostByType = useScheduledDashboardExecuteQuery(
    {
      projectId,
      query: costByTypeQuery,
      version: metricsVersion,
    },
    {
      enabled: isModelUsageEnabled,
      trpc: {
        context: {
          skipBatch: true,
        },
      },
      queryId: `${schedulerId ?? "home:model-usage"}:cost-by-type`,
      priority: 1002,
    },
  );

  const usageByTypeQuery: QueryType = {
    view: "observations",
    dimensions: [{ field: "usageType" }],
    metrics: [{ measure: "usageByType", aggregation: "sum" }],
    filters: [
      ...mapLegacyUiTableFilterToView("observations", userAndEnvFilterState),
      {
        column: "type",
        operator: "any of",
        value: getGenerationLikeTypes(),
        type: "stringOptions",
      },
      {
        column: "providedModelName",
        operator: "any of",
        value: selectedModels,
        type: "stringOptions",
      },
    ],
    timeDimension: {
      granularity:
        dashboardDateRangeAggregationSettings[agg].dateTrunc ?? "day",
    },
    fromTimestamp: fromTimestamp.toISOString(),
    toTimestamp: toTimestamp.toISOString(),
    orderBy: null,
  };

  const queryUsageByType = useScheduledDashboardExecuteQuery(
    {
      projectId,
      query: usageByTypeQuery,
      version: metricsVersion,
    },
    {
      enabled: isModelUsageEnabled,
      trpc: {
        context: {
          skipBatch: true,
        },
      },
      queryId: `${schedulerId ?? "home:model-usage"}:usage-by-type`,
      priority: 1003,
    },
  );

  // Extract unique cost/usage type keys from the data for fillMissingValuesAndTransform
  const costTypeKeys = queryCostByType.data
    ? [
        ...new Set(
          (queryCostByType.data as DatabaseRow[])
            .map((r) => r.costType as string)
            .filter((k) => k != null && k !== ""),
        ),
      ]
    : [];

  const usageTypeKeys = queryUsageByType.data
    ? [
        ...new Set(
          (queryUsageByType.data as DatabaseRow[])
            .map((r) => r.usageType as string)
            .filter((k) => k != null && k !== ""),
        ),
      ]
    : [];

  const costByType =
    queryCostByType.data && allModels.length > 0
      ? fillMissingValuesAndTransform(
          extractTimeSeriesData(
            queryCostByType.data as DatabaseRow[],
            "time_dimension",
            [
              {
                uniqueIdentifierColumns: [{ accessor: "costType" }],
                valueColumn: "sum_costByType",
              },
            ],
          ),
          costTypeKeys,
        )
      : [];

  const unitsByType =
    queryUsageByType.data && allModels.length > 0
      ? fillMissingValuesAndTransform(
          extractTimeSeriesData(
            queryUsageByType.data as DatabaseRow[],
            "time_dimension",
            [
              {
                uniqueIdentifierColumns: [{ accessor: "usageType" }],
                valueColumn: "sum_usageByType",
              },
            ],
          ),
          usageTypeKeys,
        )
      : [];

  const unitsByModel =
    queryResult.data && allModels.length > 0
      ? fillMissingValuesAndTransform(
          extractTimeSeriesData(
            queryResult.data as DatabaseRow[],
            "time_dimension",
            [
              {
                uniqueIdentifierColumns: [{ accessor: "providedModelName" }],
                valueColumn: "sum_totalTokens",
              },
            ],
          ),
          selectedModels,
        )
      : [];

  const costByModel =
    queryResult.data && allModels.length > 0
      ? fillMissingValuesAndTransform(
          extractTimeSeriesData(
            queryResult.data as DatabaseRow[],
            "time_dimension",
            [
              {
                uniqueIdentifierColumns: [{ accessor: "providedModelName" }],
                valueColumn: "sum_totalCost",
              },
            ],
          ),
          selectedModels,
        )
      : [];

  const totalCost = queryResult.data?.reduce(
    (acc, curr) =>
      acc +
      (!isNaN(Number(curr.sum_totalCost)) ? Number(curr.sum_totalCost) : 0),
    0,
  );

  const totalTokens = queryResult.data?.reduce(
    (acc, curr) =>
      acc +
      (!isNaN(Number(curr.sum_totalTokens)) ? Number(curr.sum_totalTokens) : 0),
    0,
  );

  const data = [
    {
      tabTitle: "Cost by model",
      data: costByModel,
      totalMetric: totalCostDashboardFormatted(totalCost),
      metricDescription: `Cost`,
      formatter: totalCostDashboardFormatted,
    },
    {
      tabTitle: "Cost by type",
      data: costByType,
      totalMetric: totalCostDashboardFormatted(totalCost),
      metricDescription: `Cost`,
      formatter: totalCostDashboardFormatted,
    },
    {
      tabTitle: "Usage by model",
      data: unitsByModel,
      totalMetric: totalTokens
        ? compactNumberFormatter(totalTokens)
        : compactNumberFormatter(0),
      metricDescription: `Units`,
    },
    {
      tabTitle: "Usage by type",
      data: unitsByType,
      totalMetric: totalTokens
        ? compactNumberFormatter(totalTokens)
        : compactNumberFormatter(0),
      metricDescription: `Units`,
    },
  ];

  return (
    <DashboardCard
      className={className}
      title="Model Usage"
      isLoading={
        isLoading || (queryResult.isPending && selectedModels.length > 0)
      }
      headerRight={
        <div className="flex items-center justify-end">
          <ModelSelectorPopover
            allModels={allModels}
            selectedModels={selectedModels}
            setSelectedModels={setSelectedModels}
            buttonText={buttonText}
            isAllSelected={isAllSelected}
            handleSelectAll={handleSelectAll}
          />
        </div>
      }
    >
      <TabComponent
        tabs={data.map((item) => {
          return {
            tabTitle: item.tabTitle,
            content: (
              <>
                <TotalMetric
                  metric={item.totalMetric}
                  description={item.metricDescription}
                  className="mb-4"
                />
                {isEmptyTimeSeries({ data: item.data }) ||
                isLoading ||
                queryResult.isPending ? (
                  <NoDataOrLoading
                    isLoading={isLoading || queryResult.isPending}
                  />
                ) : (
                  <div className="h-80 w-full shrink-0">
                    <Chart
                      chartType="LINE_TIME_SERIES"
                      data={timeSeriesToDataPoints(item.data, agg)}
                      rowLimit={100}
                      chartConfig={{
                        type: "LINE_TIME_SERIES",
                        show_data_point_dots: false,
                      }}
                      valueFormatter={item.formatter}
                      legendPosition="above"
                    />
                  </div>
                )}
              </>
            ),
          };
        })}
      />
    </DashboardCard>
  );
};
