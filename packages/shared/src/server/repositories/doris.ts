import { env } from "../../env";
import { dorisClient, formatDataForDoris } from "../doris/client";
import { DorisParameterProcessor } from "../doris/parameterProcessor";
import { logger } from "../logger";
import { instrumentAsync } from "../instrumentation";
import { randomUUID } from "crypto";
import { convertDateToAnalyticsDateTime } from "./analytics";

/**
 * Upsert records into Doris using Stream Load
 * Leverages Doris Unique model for native upsert capability
 */
export async function upsertDoris<T extends Record<string, unknown>>(opts: {
  table: "scores" | "traces" | "observations";
  records: T[];
  eventBodyMapper?: (body: T) => Record<string, unknown>;
  tags?: Record<string, string>;
}): Promise<void> {
  return await instrumentAsync({ name: "doris-upsert" }, async (span) => {
    span.setAttribute("doris.query.table", opts.table);
    span.setAttribute("doris.records.count", opts.records.length);

    if (opts.records.length === 0) {
      logger.warn("No records provided for Doris upsert", {
        table: opts.table,
      });
      return;
    }

    // Format records for Doris compatibility:
    // 1. Set event_ts
    // 2. Run through formatDataForDoris to generate date partition fields
    //    (timestamp_date for traces/scores, start_time_date for observations)
    //    and normalize timestamp formats. Without this, Stream Load rejects
    //    rows missing the NOT NULL date field that is part of the Unique Key.
    const withEventTs = opts.records.map((record) => ({
      ...record,
      event_ts: convertDateToAnalyticsDateTime(new Date()),
    }));
    const formattedRecords = formatDataForDoris(withEventTs, opts.table);

    try {
      // Use Stream Load for direct upsert
      // Doris Unique model will automatically handle deduplication
      await dorisClient().streamLoad(opts.table, formattedRecords, {
        format: "json",
        strip_outer_array: true,
        read_json_by_line: false,
        max_filter_ratio: 0.1,
        timeout: 600, // 10 minutes
      });

      logger.debug(`Doris upsert completed for ${opts.table}`, {
        recordCount: opts.records.length,
        table: opts.table,
      });
    } catch (error) {
      logger.error(`Doris upsert failed for ${opts.table}`, {
        error: error instanceof Error ? error.message : String(error),
        recordCount: opts.records.length,
        table: opts.table,
      });
      throw error;
    }
  });
}

/**
 * Update specific columns on a Doris Unique Key table using SQL UPDATE.
 * Only the columns in `set` are modified; all other columns (including
 * large input/output fields) are untouched. Suitable for low-frequency
 * single-row mutations like bookmark, publish, and tag updates.
 */
export async function partialUpdateDoris(opts: {
  // events_full added for the master events_full migration; legacy table
  // names retained per code-retention principle (their write paths are
  // unreachable under the OTel-only contract but the type stays valid).
  table: "traces" | "observations" | "scores" | "events_full";
  where: Record<string, unknown>;
  set: Record<string, unknown>;
}): Promise<void> {
  const setClauses: string[] = [];
  const params: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(opts.set)) {
    const paramName = `set_${key}`;
    if (Array.isArray(value)) {
      const escaped = value.map((v: unknown) =>
        typeof v === "string"
          ? `'${String(v).replace(/'/g, "''")}'`
          : String(v),
      );
      setClauses.push(`\`${key}\` = [${escaped.join(", ")}]`);
    } else if (typeof value === "boolean") {
      setClauses.push(`\`${key}\` = ${value ? "TRUE" : "FALSE"}`);
    } else if (typeof value === "number") {
      setClauses.push(`\`${key}\` = ${value}`);
    } else {
      setClauses.push(`\`${key}\` = {${paramName}: String}`);
      params[paramName] = value;
    }
  }

  const whereClauses: string[] = [];
  for (const [key, value] of Object.entries(opts.where)) {
    const paramName = `where_${key}`;
    whereClauses.push(`\`${key}\` = {${paramName}: String}`);
    params[paramName] = value;
  }

  const sql = `UPDATE \`${opts.table}\` SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;

  await queryDoris({ query: sql, params });
}

/**
 * Query Doris with parameters - compatible with ClickHouse queryClickhouse interface
 */
export async function queryDoris<T>(opts: {
  query: string;
  params?: Record<string, unknown> | undefined;
  dorisConfigs?: any; // 替换为适当的 Doris 配置类型
  tags?: Record<string, string>;
}): Promise<T[]> {
  return await instrumentAsync({ name: "doris-query" }, async (span) => {
    // Use unified parameter processor
    const processedQuery = DorisParameterProcessor.processQuery(
      opts.query,
      opts.params,
    );

    span.setAttribute("doris.query.text", processedQuery);

    try {
      if (env.NODE_ENV === "development") {
        logger.info(`doris:query:processed ${processedQuery}`);
      }

      const client = dorisClient(opts.dorisConfigs);
      const result = await client.queryWithParams({
        query: processedQuery,
        query_params: opts.params,
        format: "JSONEachRow",
      });

      const data = await result.json();

      span.setAttribute("doris.records.count", data.length);

      return data as T[];
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Doris query failed: ${errMsg}, SQL: ${processedQuery}`);
      throw error;
    }
  });
}

/**
 * Execute Doris command - compatible with ClickHouse commandClickhouse interface
 */
export async function commandDoris(opts: {
  query: string;
  params?: Record<string, unknown> | undefined;
  dorisConfigs?: any;
  tags?: Record<string, string>;
}): Promise<void> {
  return await instrumentAsync({ name: "doris-command" }, async (span) => {
    // Use unified parameter processor
    const processedQuery = DorisParameterProcessor.processQuery(
      opts.query,
      opts.params,
    );

    span.setAttribute("doris.query.text", processedQuery);

    try {
      const client = dorisClient(opts.dorisConfigs);
      await client.query(processedQuery, []);

      if (env.NODE_ENV === "development") {
        logger.info(`doris:command ${processedQuery.substring(0, 100)}...`);
      }
    } catch (error) {
      logger.error("Doris command failed", {
        query:
          processedQuery.substring(0, 200) +
          (processedQuery.length > 200 ? "..." : ""),
        error: error instanceof Error ? error.message : String(error),
        tags: opts.tags,
      });
      throw error;
    }
  });
}

/**
 * Stream query results from Doris row-by-row over the MySQL protocol.
 *
 * Compatible with ClickHouse's queryClickhouseStream interface. Backed by
 * mysql2's `connection.query(sql).stream()` so heap stays bounded and the
 * first row is delivered as soon as Doris starts emitting — critical for
 * large analytics exports (PostHog/Mixpanel historical syncs) that would
 * otherwise OOM when materializing the full result set.
 */
export async function* queryDorisStream<T>(opts: {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string>;
}): AsyncGenerator<T> {
  const tracer = require("../instrumentation").getTracer("doris-query-stream");
  const span = tracer.startSpan("doris-query-stream");

  try {
    span.setAttribute("doris.query.text", opts.query);

    const client = dorisClient();
    const processedQuery = DorisParameterProcessor.processQuery(
      opts.query,
      opts.params,
    );

    if (env.LITEFUSE_DORIS_LOG_QUERIES === "true") {
      logger.info(`doris:stream-query ${processedQuery}`);
    }

    let count = 0;
    for await (const row of client.queryStream<T>(processedQuery)) {
      count++;
      yield row;
    }
    span.setAttribute("doris.records.count", count);
  } finally {
    span.end();
  }
}

/**
 * Parse Doris date format to match ClickHouse format
 */
export function parseDorisUTCDateTimeFormat(dateString: string | Date): Date {
  // If it's already a Date object, return it directly
  if ((dateString as any) instanceof Date) {
    return dateString as Date;
  }
  // Handle both formats:
  // - MySQL format from Doris: "YYYY-MM-DD HH:MM:SS"
  // - ISO format (already converted by queryDoris): "YYYY-MM-DDTHH:MM:SS.000Z"
  if (typeof dateString !== "string") {
    // If it's not a string or Date (e.g., number timestamp), convert to Date
    return new Date(dateString as any);
  }
  if (dateString.endsWith("Z") || dateString.includes("T")) {
    return new Date(dateString);
  }
  const isoFormat = dateString.replace(" ", "T") + "Z";
  return new Date(isoFormat);
}

/**
 * Upsert a single score record
 * UNIQUE KEY: (project_id, timestamp_date, name, id)
 */
export const upsertDorisScore = async (score: Partial<any>) => {
  // Validate all UNIQUE KEY fields are present
  if (!["id", "project_id", "name", "timestamp"].every((key) => key in score)) {
    throw new Error(
      "UNIQUE KEY fields (id, project_id, name, timestamp) must be provided to upsert Score in Doris.",
    );
  }

  // Ensure timestamp_date is derived from timestamp
  const enrichedScore = {
    ...score,
    // Let Doris handle timezone conversion automatically for Date fields
    timestamp_date: score.timestamp
      ? new Date(score.timestamp).toISOString()
      : undefined,
  };

  await upsertDoris({
    table: "scores",
    records: [enrichedScore],
    tags: {
      feature: "tracing",
      type: "score",
      kind: "upsert",
      projectId: score.project_id ?? "",
    },
  });
};

/**
 * Upsert a single trace record
 * UNIQUE KEY: (project_id, timestamp_date, id)
 */
export const upsertDorisTrace = async (trace: Partial<any>) => {
  // Validate all UNIQUE KEY fields are present
  if (!["id", "project_id", "timestamp"].every((key) => key in trace)) {
    throw new Error(
      "UNIQUE KEY fields (id, project_id, timestamp) must be provided to upsert Trace in Doris.",
    );
  }

  // Ensure timestamp_date is derived from timestamp
  const enrichedTrace = {
    ...trace,
    // Let Doris handle timezone conversion automatically for Date fields
    timestamp_date: trace.timestamp
      ? new Date(trace.timestamp).toISOString()
      : undefined,
  };

  await upsertDoris({
    table: "traces",
    records: [enrichedTrace],
    tags: {
      feature: "tracing",
      type: "trace",
      kind: "upsert",
      projectId: trace.project_id ?? "",
    },
  });
};

/**
 * Upsert a single observation record
 * UNIQUE KEY: (project_id, type, start_time_date, id)
 */
export const upsertDorisObservation = async (observation: Partial<any>) => {
  // Validate all UNIQUE KEY fields are present
  if (
    !["id", "project_id", "start_time", "type"].every(
      (key) => key in observation,
    )
  ) {
    throw new Error(
      "UNIQUE KEY fields (id, project_id, start_time, type) must be provided to upsert Observation in Doris.",
    );
  }

  // Ensure start_time_date is derived from start_time
  const enrichedObservation = {
    ...observation,
    // Let Doris handle timezone conversion automatically for Date fields
    start_time_date: observation.start_time
      ? new Date(observation.start_time).toISOString()
      : undefined,
  };

  await upsertDoris({
    table: "observations",
    records: [enrichedObservation],
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "upsert",
      projectId: observation.project_id ?? "",
    },
  });
};

/**
 * Batch upsert multiple records of the same type
 */
export const batchUpsertDoris = async <
  T extends Record<string, unknown>,
>(opts: {
  table: "scores" | "traces" | "observations";
  records: T[];
  batchSize?: number;
}) => {
  const { table, records, batchSize = 1000 } = opts;

  if (records.length === 0) return;

  // Process in batches to avoid memory issues
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await upsertDoris({
      table,
      records: batch,
      tags: {
        feature: "batch-upsert",
        type: table,
        kind: "batch",
        batchIndex: Math.floor(i / batchSize).toString(),
      },
    });
  }
};

/**
 * Convert Date to Doris DateTime format using consistent timezone
 */
function convertDateToDorisDateTime(date: Date): string {
  // Use the same timezone conversion as queries to ensure consistency
  return convertDateToAnalyticsDateTime(date);
}
