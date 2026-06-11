import { queryDoris } from "./doris";
import {
  convertDateToAnalyticsDateTime,
  parseAnalyticsDateTimeFormat,
} from "./analytics";
import { createDorisFilterFromFilterState } from "../queries/doris-sql/factory";
import { FilterState } from "../../types";
import { FilterList } from "../queries";
import { DateTimeFilter as DorisDateTimeFilter } from "../queries/doris-sql/doris-filter";
import { dashboardColumnDefinitions } from "../tableMappings";

export type DateTrunc = "month" | "week" | "day" | "hour" | "minute";

const extractEnvironmentFilterFromFilters = (
  filter: FilterState,
): { envFilter: FilterState; remainingFilters: FilterState } => {
  return {
    envFilter: filter.filter((f) => f.column === "environment"),
    remainingFilters: filter.filter((f) => f.column !== "environment"),
  };
};

const convertEnvFilterToDorisFilter = (filter: FilterState, prefix = "o") => {
  return createDorisFilterFromFilterState(filter, [
    {
      select: "environment",
      tableName: "traces",
      uiTableId: "environment",
      uiTableName: "Environment",
      queryPrefix: prefix,
    },
  ]);
};

export const getScoreAggregate = async (
  projectId: string,
  filter: FilterState,
) => {
  const { envFilter, remainingFilters } =
    extractEnvironmentFilterFromFilters(filter);
  const environmentFilter = new FilterList(
    convertEnvFilterToDorisFilter(envFilter, "s"),
  ).apply();
  const dorisFilter = new FilterList(
    createDorisFilterFromFilterState(
      remainingFilters,
      dashboardColumnDefinitions,
    ),
  );

  const timeFilter = dorisFilter.find(
    (f) =>
      f.field === "start_time" && (f.operator === ">=" || f.operator === ">"),
  ) as DorisDateTimeFilter | undefined;

  const dorisFilterApplied = dorisFilter.apply();

  const hasTraceFilter = dorisFilter.find((f) => f.table === "traces");

  // Doris UNIQUE KEY 保证数据唯一性，不需要 ROW_NUMBER() 去重
  const query = `
      SELECT 
        s.name,
        count(*) as count,
        avg(s.value) as avg_value,
        s.source,
        s.data_type
      FROM scores s
      ${hasTraceFilter ? `JOIN events_full t ON t.trace_id = s.trace_id AND t.project_id = s.project_id AND t.parent_span_id = ''` : ""}
      WHERE s.project_id = {projectId: String}
      ${dorisFilterApplied.query ? `AND ${dorisFilterApplied.query}` : ""}
      ${environmentFilter.query ? `AND ${environmentFilter.query}` : ""}
      ${timeFilter && hasTraceFilter ? `AND t.start_time >= DATE_SUB({tracesTimestamp: DateTime}, INTERVAL 2 DAY)` : ""}
      GROUP BY s.name, s.source, s.data_type
      ORDER BY count(*) DESC
      `;

  const result = await queryDoris<{
    name: string;
    count: string;
    avg_value: string;
    source: string;
    data_type: string;
  }>({
    query,
    params: {
      projectId,
      ...dorisFilterApplied.params,
      ...environmentFilter.params,
      ...(timeFilter
        ? {
            tracesTimestamp: convertDateToAnalyticsDateTime(timeFilter.value),
          }
        : {}),
    },
    tags: {
      feature: "dashboard",
      type: "scoreAggregate",
      kind: "analytic",
      projectId,
    },
  });

  return result;
};

export const getObservationCostByTypeByTime = async (
  projectId: string,
  filter: FilterState,
) => {
  const { envFilter, remainingFilters } =
    extractEnvironmentFilterFromFilters(filter);
  const environmentFilter = new FilterList(
    convertEnvFilterToDorisFilter(envFilter),
  ).apply();
  const dorisFilter = new FilterList(
    createDorisFilterFromFilterState(
      remainingFilters,
      dashboardColumnDefinitions,
    ),
  );

  const appliedFilter = dorisFilter.apply();

  const tracesFilter = dorisFilter.find((f) => f.table === "traces");
  const timeFilter = tracesFilter
    ? (dorisFilter.find(
        (f) =>
          f.table === "observations" &&
          f.field.includes("start_time") &&
          (f.operator === ">=" || f.operator === ">"),
      ) as DorisDateTimeFilter | undefined)
    : undefined;

  const [orderByQuery, orderByParams, bucketSizeInSeconds] =
    orderByTimeSeriesDoris(filter, "start_time");

  // Doris UNIQUE KEY 保证数据唯一性，无需去重
  // 用 collect_list 构造与上游等价的 groupArray 结构
  const query = `
      SELECT 
          start_time,
          collect_list(CONCAT(cost_key, ':', CAST(cost_sum AS STRING))) AS costs
      FROM (
          SELECT 
              ${selectTimeseriesColumnDoris(bucketSizeInSeconds, "start_time", "start_time")},
              keys_exploded.cost_key as cost_key, 
              SUM(values_exploded.cost_value) AS cost_sum
          FROM events_full o
          LATERAL VIEW posexplode(map_keys(cost_details)) keys_exploded AS key_pos, cost_key
          LATERAL VIEW posexplode(map_values(cost_details)) values_exploded AS value_pos, cost_value
          ${tracesFilter ? `LEFT JOIN events_full t ON o.trace_id = t.trace_id AND o.project_id = t.project_id AND t.parent_span_id = ''` : ""}
          WHERE o.project_id = {projectId: String}
          ${appliedFilter.query ? `AND ${appliedFilter.query}` : ""}
          ${environmentFilter.query ? `AND ${environmentFilter.query}` : ""}
          ${timeFilter ? `AND t.start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)` : ""}
          AND cost_details IS NOT NULL
          AND keys_exploded.key_pos = values_exploded.value_pos
          GROUP BY
              start_time,
              cost_key
      ) subquery
      GROUP BY 
          start_time 
      ${orderByQuery}
    `;

  const result = await queryDoris<{
    start_time: string | Date;
    costs: string[] | string; // 格式: ["key1:value1", "key2:value2", ...] 或字符串化的数组
  }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
      ...environmentFilter.params,
      ...orderByParams,
      ...(timeFilter
        ? { traceTimestamp: convertDateToAnalyticsDateTime(timeFilter.value) }
        : {}),
    },
    tags: {
      feature: "dashboard",
      type: "observationCostByTypeByTime",
      kind: "analytic",
      projectId,
    },
  });

  // 解析字符串格式的 costs，转换为与上游一致的元组格式
  const processedResult = result.map((row) => {
    let costArray: string[] = [];

    // 处理 Doris 返回的字符串化数组
    if (typeof row.costs === "string") {
      try {
        costArray = JSON.parse(row.costs);
      } catch (e) {
        console.error("Failed to parse costs JSON:", e);
        costArray = [];
      }
    } else if (Array.isArray(row.costs)) {
      costArray = row.costs;
    }

    return {
      start_time: row.start_time,
      costs: costArray.map((cost): [string, number | null] => {
        const [key, value] = cost.split(":");
        return [key, value ? Number(value) : null];
      }),
    };
  });

  // 与上游同款处理逻辑
  const types = processedResult.flatMap((row) => {
    return row.costs.map((cost) => cost[0]);
  });

  const uniqueTypes = [...new Set(types)];

  return processedResult.flatMap((row) => {
    const timeString =
      typeof row.start_time === "string"
        ? row.start_time
        : (row.start_time as Date).toISOString();
    const intervalStart = parseAnalyticsDateTimeFormat(timeString);
    return uniqueTypes.map((type) => ({
      intervalStart: intervalStart,
      key: type,
      sum: row.costs.find((cost) => cost[0] === type)?.[1]
        ? Number(row.costs.find((cost) => cost[0] === type)?.[1])
        : 0,
    }));
  });
};

export const getObservationUsageByTypeByTime = async (
  projectId: string,
  filter: FilterState,
) => {
  const { envFilter, remainingFilters } =
    extractEnvironmentFilterFromFilters(filter);
  const environmentFilter = new FilterList(
    convertEnvFilterToDorisFilter(envFilter),
  ).apply();
  const dorisFilter = new FilterList(
    createDorisFilterFromFilterState(
      remainingFilters,
      dashboardColumnDefinitions,
    ),
  );

  const appliedFilter = dorisFilter.apply();

  const tracesFilter = dorisFilter.find((f) => f.table === "traces");
  const timeFilter = tracesFilter
    ? (dorisFilter.find(
        (f) =>
          f.table === "observations" &&
          f.field.includes("start_time") &&
          (f.operator === ">=" || f.operator === ">"),
      ) as DorisDateTimeFilter | undefined)
    : undefined;

  const [orderByQuery, orderByParams, bucketSizeInSeconds] =
    orderByTimeSeriesDoris(filter, "start_time");

  // Doris UNIQUE KEY 保证数据唯一性，无需去重
  // 用 collect_list 构造与上游等价的 groupArray 结构
  const query = `
      SELECT 
          start_time,
          collect_list(CONCAT(usage_key, ':', CAST(usage_sum AS STRING))) AS usages
      FROM (
          SELECT 
              ${selectTimeseriesColumnDoris(bucketSizeInSeconds, "start_time", "start_time")},
              keys_exploded.usage_key as usage_key, 
              SUM(values_exploded.usage_value) AS usage_sum
          FROM events_full o
          LATERAL VIEW posexplode(map_keys(usage_details)) keys_exploded AS key_pos, usage_key
          LATERAL VIEW posexplode(map_values(usage_details)) values_exploded AS value_pos, usage_value
          ${tracesFilter ? `LEFT JOIN events_full t ON o.trace_id = t.trace_id AND o.project_id = t.project_id AND t.parent_span_id = ''` : ""}
          WHERE o.project_id = {projectId: String}
          ${appliedFilter.query ? `AND ${appliedFilter.query}` : ""}
          ${environmentFilter.query ? `AND ${environmentFilter.query}` : ""}
          ${timeFilter ? `AND t.start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)` : ""}
          AND usage_details IS NOT NULL
          AND keys_exploded.key_pos = values_exploded.value_pos
          GROUP BY
              start_time,
              usage_key
      ) subquery
      GROUP BY 
          start_time 
      ${orderByQuery}
    `;

  const result = await queryDoris<{
    start_time: string | Date;
    usages: string[] | string; // 格式: ["key1:value1", "key2:value2", ...] 或字符串化的数组
  }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
      ...environmentFilter.params,
      ...orderByParams,
      ...(timeFilter
        ? { traceTimestamp: convertDateToAnalyticsDateTime(timeFilter.value) }
        : {}),
    },
    tags: {
      feature: "dashboard",
      type: "observationUsageByTime",
      kind: "analytic",
      projectId,
    },
  });

  // 解析字符串格式的 usages，转换为与上游一致的元组格式
  const processedResult = result.map((row) => {
    let usageArray: string[] = [];

    // 处理 Doris 返回的字符串化数组
    if (typeof row.usages === "string") {
      try {
        usageArray = JSON.parse(row.usages);
      } catch (e) {
        console.error("Failed to parse usages JSON:", e);
        usageArray = [];
      }
    } else if (Array.isArray(row.usages)) {
      usageArray = row.usages;
    }

    return {
      start_time: row.start_time,
      usages: usageArray.map((usage): [string, number | null] => {
        const [key, value] = usage.split(":");
        return [key, value ? Number(value) : null];
      }),
    };
  });

  // 与上游同款处理逻辑
  const types = processedResult.flatMap((row) => {
    return row.usages.map((usage) => usage[0]);
  });

  const uniqueTypes = [...new Set(types)];

  return processedResult.flatMap((row) => {
    const timeString =
      typeof row.start_time === "string"
        ? row.start_time
        : (row.start_time as Date).toISOString();
    const intervalStart = parseAnalyticsDateTimeFormat(timeString);
    return uniqueTypes.map((type) => ({
      intervalStart: intervalStart,
      key: type,
      sum: row.usages.find((usage) => usage[0] === type)?.[1]
        ? Number(row.usages.find((usage) => usage[0] === type)?.[1])
        : 0,
    }));
  });
};

export const orderByTimeSeriesDoris = (
  filter: FilterState,
  col: string,
): [string, { fromTime: number; toTime: number }, number] => {
  const potentialBucketSizesSeconds = [
    5, 10, 30, 60, 300, 600, 1800, 3600, 18000, 36000, 86400, 604800, 2592000,
  ];

  // Calculate time difference in seconds
  const [from, to] = extractFromAndToTimestampsFromFilter(filter);

  if (!from || !to) {
    throw new Error("Time Filter is required for time series queries");
  }

  const fromDate = new Date(from.value as Date);
  const toDate = new Date(to.value as Date);

  const diffInSeconds = Math.abs(toDate.getTime() - fromDate.getTime()) / 1000;

  // choose the bucket size that is the closest to the desired number of buckets
  const bucketSizeInSeconds = potentialBucketSizesSeconds.reduce(
    (closest, size) => {
      const diffFromDesiredBuckets = Math.abs(diffInSeconds / size - 50);
      return diffFromDesiredBuckets < closest.diffFromDesiredBuckets
        ? { size, diffFromDesiredBuckets }
        : closest;
    },
    { size: 0, diffFromDesiredBuckets: Infinity },
  ).size;

  return [
    `ORDER BY ${col} ASC`,
    { fromTime: fromDate.getTime(), toTime: toDate.getTime() },
    bucketSizeInSeconds,
  ];
};

export const selectTimeseriesColumnDoris = (
  bucketSizeInSeconds: number,
  col: string,
  as: String,
) => {
  // Use DATE_TRUNC for better performance in Doris with DateTime(3) fields
  if (bucketSizeInSeconds >= 86400) {
    return `DATE_TRUNC(${col}, 'day') as ${as}`;
  } else if (bucketSizeInSeconds >= 3600) {
    return `DATE_TRUNC(${col}, 'hour') as ${as}`;
  } else if (bucketSizeInSeconds >= 60) {
    return `DATE_TRUNC(${col}, 'minute') as ${as}`;
  } else {
    // For sub-minute intervals, use DATE_TRUNC with second precision and manual bucketing
    // Since col is now DateTime(3), we can use DATE_TRUNC directly
    return `DATE_TRUNC(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(${col}) / ${bucketSizeInSeconds}) * ${bucketSizeInSeconds}), 'second') as ${as}`;
  }
};

export const extractFromAndToTimestampsFromFilter = (filter?: FilterState) => {
  if (!filter)
    throw new Error("Time Filter is required for time series queries");

  const fromTimestamp = filter.filter(
    (f) => f.type === "datetime" && (f.operator === ">" || f.operator === ">="),
  );

  const toTimestamp = filter.filter(
    (f) => f.type === "datetime" && (f.operator === "<" || f.operator === "<="),
  );

  return [fromTimestamp[0], toTimestamp[0]];
};
