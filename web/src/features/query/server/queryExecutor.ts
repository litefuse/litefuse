import { queryDoris } from "@langfuse/shared/src/server";
import { QueryBuilder } from "@/src/features/query/server/queryBuilder";
import { type QueryType, type ViewVersion } from "@/src/features/query/types";
import { getViewDeclaration } from "@/src/features/query/dataModel";
import { env } from "@/src/env.mjs";

// Re-export validation logic (shared between server and client)
export {
  validateQuery,
  type QueryValidationResult,
} from "@/src/features/query/validateQuery";

/**
 * Execute a query using the QueryBuilder.
 *
 * @param projectId - The project ID
 * @param query - The query configuration as defined in QueryType
 * @param version - The view version to use (v1 or v2), defaults to v1
 * @param enableSingleLevelOptimization - Enable single-level SELECT optimization (default: false)
 * @returns The query result data
 */
export async function executeQuery(
  projectId: string,
  query: QueryType,
  version: ViewVersion = "v1",
  enableSingleLevelOptimization: boolean = false,
): Promise<Array<Record<string, unknown>>> {
  // Remap config to chartConfig for public API compatibility
  // Public API uses "config" while internal QueryType uses "chartConfig"
  const chartConfig =
    (query as unknown as { config?: QueryType["chartConfig"] }).config ??
    query.chartConfig;
  const queryBuilder = new QueryBuilder(chartConfig, version);

  // Build the query (with or without optimization based on flag)
  const { query: compiledQuery, parameters } = await queryBuilder.build(
    query,
    projectId,
    enableSingleLevelOptimization,
  );

  const tags = {
    feature: "custom-queries",
    type: query.view,
    kind: "analytic",
    projectId,
  };

  // Route to Doris backend when configured
  const rows = await queryDoris<Record<string, unknown>>({
    query: compiledQuery,
    params: parameters,
    tags,
  });

  // Doris mysql2 driver returns Decimal/BigInt as strings and timestamps
  // as Date objects. Convert to match ClickHouse output format for frontend.
  const converted = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) {
        // Output ISO 8601 format with timezone indicator so frontend
        // correctly interprets as UTC (matching ClickHouse iso output)
        out[key] = value.toISOString();
      } else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        out[key] = Number(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  });

  // Doris doesn't support WITH FILL. Fill time gaps with zeros to match
  // ClickHouse behavior for continuous time series charts.
  // Skip gap-filling when ORDER BY is specified (ClickHouse also skips
  // WITH FILL when ORDER BY is present).
  const hasOrderBy = query.orderBy && query.orderBy.length > 0;
  if (query.timeDimension && converted.length > 0 && !hasOrderBy) {
    return fillTimeSeriesGaps(
      converted,
      query.timeDimension,
      query.fromTimestamp,
      query.toTimestamp,
    );
  }

  return converted;
}

/**
 * Fill time series gaps with zero values for Doris queries.
 * ClickHouse uses WITH FILL natively; Doris needs application-level fill.
 *
 * When breakdown dimensions are present (e.g., grouped by type), each
 * dimension combination is filled independently so that every series has
 * a continuous set of time buckets.
 */
function fillTimeSeriesGaps(
  rows: Record<string, unknown>[],
  timeDimension: NonNullable<QueryType["timeDimension"]>,
  fromTimestamp: string,
  toTimestamp: string,
): Record<string, unknown>[] {
  if (rows.length === 0) return rows;

  // Find the time dimension key in the data (supports both ISO 8601 and plain datetime format)
  const timeKey = Object.keys(rows[0]!).find((k) => {
    const v = rows[0]![k];
    return (
      typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(v as string)
    );
  });
  if (!timeKey) return rows;

  // Determine granularity
  const granularity =
    timeDimension.granularity === "auto"
      ? determineGranularity(fromTimestamp, toTimestamp)
      : timeDimension.granularity;

  const stepMs: Record<string, number> = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  const step = stepMs[granularity];
  if (!step) return rows;

  // Identify metric keys (numeric) vs dimension keys (non-time strings).
  // Metric columns come from SQL aggregations (count, sum, etc.) and are
  // always numeric, but may be null in some rows. Check across all rows
  // so a column whose first-row value is null is still correctly classified.
  const metricKeys: string[] = [];
  const dimensionKeys: string[] = [];
  const nonTimeKeys = Object.keys(rows[0]!).filter((k) => k !== timeKey);
  for (const key of nonTimeKeys) {
    const hasNumber = rows.some((row) => typeof row[key] === "number");
    if (hasNumber) {
      metricKeys.push(key);
    } else {
      dimensionKeys.push(key);
    }
  }

  const truncate = (d: Date): Date => {
    const t = new Date(d);
    switch (granularity) {
      case "minute":
        t.setUTCSeconds(0, 0);
        break;
      case "hour":
        t.setUTCMinutes(0, 0, 0);
        break;
      case "day":
        t.setUTCHours(0, 0, 0, 0);
        break;
      case "week": {
        const day = t.getUTCDay();
        t.setUTCDate(t.getUTCDate() - ((day + 6) % 7));
        t.setUTCHours(0, 0, 0, 0);
        break;
      }
      case "month":
        t.setUTCDate(1);
        t.setUTCHours(0, 0, 0, 0);
        break;
    }
    return t;
  };

  const formatTs = (d: Date): string => d.toISOString();

  // Generate all time buckets
  const start = truncate(new Date(fromTimestamp));
  const end = new Date(toTimestamp);
  const allTimeBuckets: string[] = [];
  for (let t = start; t <= end; t = new Date(t.getTime() + step)) {
    allTimeBuckets.push(formatTs(t));
  }

  // No breakdown dimensions: simple fill (one series)
  if (dimensionKeys.length === 0) {
    const existingMap = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      existingMap.set(row[timeKey] as string, row);
    }
    const zeroTemplate: Record<string, unknown> = {};
    for (const key of metricKeys) {
      zeroTemplate[key] = 0;
    }
    return allTimeBuckets.map(
      (ts) => existingMap.get(ts) ?? { ...zeroTemplate, [timeKey]: ts },
    );
  }

  // With breakdown dimensions: add fill rows with empty-string dimensions
  // and zero metrics for time buckets without any data.  This matches
  // ClickHouse WITH FILL behavior: fill rows get default values ("" for
  // strings, 0 for numbers).  The frontend's DashboardWidget converts
  // empty-string dimensions to "n/a", creating a flat zero-value series
  // that extends the X-axis to the full from/to range — identical to CK.
  const result: Record<string, unknown>[] = [...rows];

  const existingTimestamps = new Set(rows.map((r) => r[timeKey] as string));

  // Match ClickHouse WITH FILL default values per column type:
  // - Nullable columns: WITH FILL default = null → frontend shows "n/a" series
  // - Non-Nullable columns: WITH FILL default = "" → frontend filters it out
  // Detect by checking if the actual data already has null values for each
  // dimension column. If yes → column is Nullable → use null. If no → use "".
  const fillDimValues: Record<string, unknown> = {};
  for (const key of dimensionKeys) {
    const hasNullInData = rows.some(
      (r) => r[key] === null || r[key] === undefined,
    );
    fillDimValues[key] = hasNullInData ? null : "";
  }
  const nullMetrics: Record<string, unknown> = {};
  for (const key of metricKeys) {
    nullMetrics[key] = null;
  }

  for (const ts of allTimeBuckets) {
    if (!existingTimestamps.has(ts)) {
      result.push({
        [timeKey]: ts,
        ...fillDimValues,
        ...nullMetrics,
      });
    }
  }

  // Sort by time dimension to match CK's WITH FILL output order.
  // Without sorting, data rows come first then fill rows appended at end,
  // causing groupDataByTimeDimension to produce wrong X-axis order.
  result.sort((a, b) => {
    const ta = a[timeKey] as string;
    const tb = b[timeKey] as string;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  return result;
}

function determineGranularity(
  fromTimestamp: string,
  toTimestamp: string,
): string {
  const diffMs =
    new Date(toTimestamp).getTime() - new Date(fromTimestamp).getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours < 2) return "minute";
  if (diffHours < 72) return "hour";
  if (diffHours < 1440) return "day";
  if (diffHours < 8760) return "week";
  return "month";
}
