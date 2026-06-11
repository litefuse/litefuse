import { convertApiProvidedFilterToDorisFilter } from "@langfuse/shared/src/server";
import {
  convertDateToAnalyticsDateTime,
  queryDoris,
  type DateTimeFilter,
  measureAndReturn,
} from "@langfuse/shared/src/server";

type QueryType = {
  page: number;
  limit: number;
  projectId: string;
  userId?: string;
  tags?: string | string[];
  traceName?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

type DailyUsageRow = {
  date: string;
  model: string | null;
  inputUsage: number;
  outputUsage: number;
  totalUsage: number;
  totalCost: number;
  countObservations: number;
  countTraces: number;
};

type DailyTraceCountRow = {
  date: string;
  countTraces: number;
};

export const generateDailyMetrics = async (props: QueryType) => {
  const filter = convertApiProvidedFilterToDorisFilter(props, filterParams);
  const hasTracesFilter = filter.some((f) => f.table === "traces");
  const tracesFilter = filter.filter((f) => f.table === "traces");
  const appliedFilter = filter.apply();
  const appliedTracesFilter = tracesFilter.apply();

  const timeFilter = filter.find(
    (f) =>
      f.table === "traces" &&
      f.field.includes("start_time") &&
      (f.operator === ">=" || f.operator === ">"),
  ) as DateTimeFilter | undefined;

  const hasNonTimestampsFilter =
    (timeFilter && filter.length() > 1) || (!timeFilter && filter.length() > 0);

  // Observation-side per-date per-model metrics
  const obsQuery = `
    SELECT
      DATE(o.start_time) AS date,
      o.provided_model_name AS model,
      count(o.span_id) AS countObservations,
      count(distinct o.trace_id) AS countTraces,
      COALESCE(sum(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(o.usage_details), map_keys(o.usage_details)))), 0) AS inputUsage,
      COALESCE(sum(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(o.usage_details), map_keys(o.usage_details)))), 0) AS outputUsage,
      COALESCE(sum(if(MAP_CONTAINS_KEY(o.usage_details, 'total'), o.usage_details['total'], 0)), 0) AS totalUsage,
      COALESCE(sum(coalesce(o.total_cost, 0)), 0) AS totalCost
    FROM events_full o
    ${hasNonTimestampsFilter ? "LEFT JOIN events_full t ON o.trace_id = t.trace_id AND o.project_id = t.project_id AND t.parent_span_id = ''" : ""}
    WHERE o.project_id = {projectId: String}
    ${hasNonTimestampsFilter ? `AND ${appliedFilter.query}` : ""}
    ${timeFilter ? `AND o.start_time >= DATE_SUB({cteTimeFilter: DateTime}, INTERVAL 2 DAY)` : ""}
    GROUP BY date, model
  `;

  // Trace-side per-date counts
  const traceQuery = `
    SELECT
      DATE(t.start_time) AS date,
      count(t.trace_id) AS countTraces
    FROM events_full t
    WHERE t.project_id = {projectId: String}
    AND t.parent_span_id = ''
    ${hasTracesFilter ? `AND ${appliedTracesFilter.query}` : ""}
    GROUP BY date
  `;

  const timestamp = props.fromTimestamp
    ? new Date(props.fromTimestamp)
    : timeFilter?.value;

  return measureAndReturn({
    operationName: "generateDailyMetrics",
    projectId: props.projectId,
    input: {
      params: {
        ...appliedTracesFilter.params,
        ...appliedFilter.params,
        projectId: props.projectId,
        ...(timeFilter
          ? {
              cteTimeFilter: convertDateToAnalyticsDateTime(timeFilter.value),
            }
          : {}),
      },
      tags: {
        feature: "tracing",
        type: "trace",
        kind: "daily_metrics",
        projectId: props.projectId,
        operation_name: "generateDailyMetrics",
      },
      timestamp,
    },
    fn: async (input) => {
      const [obsRows, traceRows] = await Promise.all([
        queryDoris<DailyUsageRow>({
          query: obsQuery,
          params: input.params,
          tags: input.tags,
        }),
        queryDoris<DailyTraceCountRow>({
          query: traceQuery,
          params: input.params,
          tags: input.tags,
        }),
      ]);

      // Group obs rows by date
      const dailyMap = new Map<
        string,
        {
          countTraces: number;
          countObservations: number;
          totalCost: number;
          usage: DailyUsageRow[];
        }
      >();

      for (const r of obsRows) {
        const dateKey = String(r.date);
        const entry = dailyMap.get(dateKey) ?? {
          countTraces: 0,
          countObservations: 0,
          totalCost: 0,
          usage: [],
        };
        entry.countObservations += Number(r.countObservations);
        entry.totalCost += Number(r.totalCost);
        entry.usage.push(r);
        dailyMap.set(dateKey, entry);
      }

      for (const r of traceRows) {
        const dateKey = String(r.date);
        const entry = dailyMap.get(dateKey) ?? {
          countTraces: 0,
          countObservations: 0,
          totalCost: 0,
          usage: [],
        };
        entry.countTraces = Number(r.countTraces);
        dailyMap.set(dateKey, entry);
      }

      const sorted = Array.from(dailyMap.entries())
        .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
        .map(([date, v]) => ({
          date,
          countTraces: v.countTraces,
          countObservations: v.countObservations,
          totalCost: v.totalCost,
          usage: v.usage.map((u) => ({
            model: u.model,
            inputUsage: Number(u.inputUsage),
            outputUsage: Number(u.outputUsage),
            totalUsage: Number(u.totalUsage),
            totalCost: Number(u.totalCost),
            countObservations: Number(u.countObservations),
            countTraces: Number(u.countTraces),
          })),
        }));

      const start =
        props.page !== undefined && props.limit !== undefined
          ? (props.page - 1) * props.limit
          : 0;
      const end =
        props.page !== undefined && props.limit !== undefined
          ? start + props.limit
          : sorted.length;
      return sorted.slice(start, end);
    },
  });
};

export const getDailyMetricsCount = async (props: QueryType) => {
  const filter = convertApiProvidedFilterToDorisFilter(props, filterParams);
  const appliedFilter = filter.filter((f) => f.table === "traces").apply();

  const query = `
    SELECT count(distinct DATE(t.start_time)) as count
    FROM events_full t
    WHERE t.project_id = {projectId: String}
    AND t.parent_span_id = ''
    ${filter.length() > 0 ? `AND ${appliedFilter.query}` : ""}
  `;

  const timestamp = props.fromTimestamp
    ? new Date(props.fromTimestamp)
    : undefined;

  return measureAndReturn({
    operationName: "getDailyMetricsCount",
    projectId: props.projectId,
    input: {
      params: { ...appliedFilter.params, projectId: props.projectId },
      tags: {
        feature: "tracing",
        type: "trace",
        kind: "daily_metrics_count",
        projectId: props.projectId,
        operation_name: "getDailyMetricsCount",
      },
      timestamp,
    },
    fn: async (input) => {
      const records = await queryDoris<{ count: string }>({
        query,
        params: input.params,
        tags: input.tags,
      });
      return records.map((record) => Number(record.count)).shift();
    },
  });
};

const filterParams = [
  {
    id: "userId",
    dorisSelect: "user_id",
    filterType: "StringFilter",
    dorisTable: "traces",
    dorisPrefix: "t",
  },
  {
    id: "traceName",
    dorisSelect: "name",
    filterType: "StringFilter",
    dorisTable: "traces",
    dorisPrefix: "t",
  },
  {
    id: "tags",
    dorisSelect: "tags",
    filterType: "ArrayOptionsFilter",
    dorisTable: "traces",
    dorisPrefix: "t",
  },
  {
    id: "traceEnvironment",
    dorisSelect: "environment",
    filterType: "StringOptionsFilter",
    dorisTable: "traces",
    dorisPrefix: "t",
  },
  {
    id: "observationEnvironment",
    dorisSelect: "environment",
    filterType: "StringOptionsFilter",
    dorisTable: "observations",
    dorisPrefix: "o",
  },
  {
    id: "fromTimestamp",
    dorisSelect: "start_time",
    operator: ">=" as const,
    filterType: "DateTimeFilter",
    dorisTable: "traces",
    dorisPrefix: "t",
  },
  {
    id: "toTimestamp",
    dorisSelect: "start_time",
    operator: "<" as const,
    filterType: "DateTimeFilter",
    dorisTable: "traces",
    dorisPrefix: "t",
  },
];
