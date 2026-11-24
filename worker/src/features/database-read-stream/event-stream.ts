/**
 * Event stream for batch exports.
 * Queries the Doris events table with filters and streams results
 * for efficient batch export processing.
 *
 * The events table is denormalized with trace data already included,
 * so no JOINs are needed for trace-level fields.
 */

import {
  FilterCondition,
  ScoreDataTypeEnum,
  TimeFilter,
  TracingSearchType,
} from "@langfuse/shared";
import {
  getDistinctScoreNames,
  queryDorisStream,
  logger,
  FilterList,
  createFilterFromFilterState,
  eventsTableUiColumnDefinitionsForDoris,
  dorisSearchCondition,
  tableFor,
} from "@langfuse/shared/src/server";
import { Readable } from "stream";
import { env } from "../../env";
import {
  getChunkWithFlattenedScores,
  prepareScoresForOutput,
} from "./getDatabaseReadStream";
import { fetchCommentsForExport } from "./fetchCommentsForExport";
import { BatchExportEventsRow } from "./types";

const BATCH_SIZE = 1000; // Fetch comments in batches for efficiency

/**
 * Creates a stream of events from Doris for batch export.
 * Includes comments fetched in batches and flattened scores.
 *
 * @param props - Query parameters including projectId, filters, and limits
 * @returns A Node.js Readable stream of event records
 */
export const getEventsStream = async (props: {
  projectId: string;
  cutoffCreatedAt: Date;
  filter: FilterCondition[] | null;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  rowLimit?: number;
}): Promise<Readable> => {
  const {
    projectId,
    cutoffCreatedAt,
    filter = [],
    searchQuery,
    searchType,
    rowLimit = env.BATCH_EXPORT_ROW_LIMIT,
  } = props;

  // Filter out score and comment filters since they require special handling
  const eventOnlyFilters = (filter ?? []).filter((f) => {
    const columnDef = eventsTableUiColumnDefinitionsForDoris.find(
      (col) => col.uiTableName === f.column || col.uiTableId === f.column,
    );
    // Keep the filter if it's not a scores or comments filter
    return (
      columnDef?.tableName !== "scores" && columnDef?.tableName !== "comments"
    );
  });

  // Get distinct score names for empty columns
  const distinctScoreNames = await getDistinctScoreNames({
    projectId,
    cutoffCreatedAt,
    filter: eventOnlyFilters,
    isTimestampFilter: (
      filterItem: FilterCondition,
    ): filterItem is TimeFilter =>
      filterItem.column === "Start Time" && filterItem.type === "datetime",
  });

  const emptyScoreColumns = distinctScoreNames.reduce(
    (acc, name) => ({ ...acc, [name]: null }),
    {} as Record<string, null>,
  );

  // Build filters for events (project_id is handled by the query builder)
  const eventsFilter = new FilterList(
    createFilterFromFilterState(
      [
        ...eventOnlyFilters,
        {
          column: "startTime",
          operator: "<" as const,
          value: cutoffCreatedAt,
          type: "datetime" as const,
        },
      ],
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedEventsFilter = eventsFilter.apply();

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "observations",
    hasTracesJoin: false,
  });

  // Build the query using raw SQL for Doris per-project split spans table
  const query = `
    WITH scores_agg AS (
      SELECT
        trace_id,
        observation_id,
        collect_list(
          CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN
            struct(name, avg_val)
          END
        ) AS scores_avg,
        array_except(
          collect_list(
            CASE WHEN data_type = 'CATEGORICAL' AND string_value IS NOT NULL AND string_value != '' THEN
              CONCAT(name, ':', string_value)
            ELSE NULL END
          ),
          [NULL]
        ) AS score_categories,
        CONCAT('[', COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN JSON_OBJECT('name', name, 'value', avg_val, 'dataType', data_type, 'stringValue', COALESCE(string_value, '')) ELSE NULL END), ''), ']') AS scores_json,
        CONCAT('[', COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN data_type = 'CATEGORICAL' THEN JSON_OBJECT('name', name, 'stringValue', string_value) ELSE NULL END), ''), ']') AS score_categories_tuples
      FROM (
        SELECT
          trace_id,
          observation_id,
          name,
          ROUND(avg(value), 6) as avg_val,
          data_type,
          string_value
        FROM scores
        WHERE project_id = {projectId: String}
        GROUP BY
          trace_id,
          observation_id,
          name,
          data_type,
          string_value
      ) tmp
      GROUP BY trace_id, observation_id
    )
    SELECT
      o.span_id AS id,
      o.trace_id,
      o.project_id,
      o.start_time,
      o.end_time,
      o.name,
      o.type,
      o.environment,
      o.version,
      o.user_id,
      o.session_id,
      o.level,
      o.status_message,
      o.prompt_name,
      o.prompt_id,
      o.prompt_version,
      o.model_id,
      o.provided_model_name,
      o.model_parameters,
      o.usage_details,
      o.cost_details,
      o.total_cost,
      o.input,
      o.output,
      json_object_flatten(o.metadata) AS metadata,
      o.completion_start_time,
      IF(o.end_time IS NULL, NULL, milliseconds_diff(o.end_time, o.start_time)) AS latency,
      IF(o.completion_start_time IS NULL, NULL, milliseconds_diff(o.completion_start_time, o.start_time)) AS time_to_first_token,
      o.tags,
      o.\`release\` AS \`release\`,
      o.trace_name,
      o.parent_span_id AS parent_observation_id,
      s.scores_json,
      s.score_categories_tuples
    FROM ${tableFor(projectId, "spans")} o
    LEFT JOIN scores_agg s ON s.trace_id = o.trace_id AND s.observation_id = o.span_id
    WHERE o.project_id = {projectId: String}
      AND o.span_id NOT LIKE 't-%'
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
    ORDER BY o.start_time DESC
    LIMIT {rowLimit: Int64}
  `;

  const queryParams = {
    projectId,
    rowLimit,
    ...appliedEventsFilter.params,
    ...search.params,
  };

  const parseJsonIfString = <T>(value: T | string): T => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  };

  type EventRow = {
    id: string;
    trace_id: string;
    project_id: string;
    start_time: Date;
    end_time: Date | null;
    name: string | null;
    type: string;
    environment: string | null;
    version: string | null;
    user_id: string | null;
    session_id: string | null;
    level: string;
    status_message: string | null;
    prompt_name: string | null;
    prompt_id: string | null;
    prompt_version: number | null;
    model_id: string | null;
    provided_model_name: string | null;
    model_parameters: unknown;
    usage_details: Record<string, number> | string;
    cost_details: Record<string, number> | string;
    total_cost: number | null;
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown> | string;
    completion_start_time: Date | null;
    latency: number | null;
    time_to_first_token: number | null;
    tags: string[] | string | null;
    release: string | null;
    trace_name: string | null;
    parent_observation_id: string | null;
    scores_json: string | undefined;
    score_categories_tuples: string | undefined;
  };

  const asyncGenerator = queryDorisStream<EventRow>({
    query,
    params: queryParams,
    tags: {
      feature: "batch-export",
      type: "event",
      kind: "export",
      projectId,
    },
  });

  // Helper function to process a single event row
  const processEventRow = (
    bufferedRow: EventRow,
    commentsByEvent: Map<string, any[]>,
  ) => {
    // Process numeric/boolean scores (JSON from Doris)
    const numericScores = (
      bufferedRow.scores_json ? JSON.parse(bufferedRow.scores_json) : []
    ).map((score: any) => ({
      name: score.name,
      value: score.value,
      dataType: score.dataType,
      stringValue: score.stringValue,
    }));

    // Process categorical scores (JSON from Doris)
    const categoricalScores = (
      bufferedRow.score_categories_tuples
        ? JSON.parse(bufferedRow.score_categories_tuples)
        : []
    ).map((cat: any) => ({
      name: cat.name,
      value: null,
      dataType: ScoreDataTypeEnum.CATEGORICAL,
      stringValue: cat.stringValue,
    }));

    const outputScores: Record<string, string[] | number[]> =
      prepareScoresForOutput([...numericScores, ...categoricalScores]);

    // Get comments for this event (events use OBSERVATION type since they are observations)
    const eventComments = commentsByEvent.get(bufferedRow.id) ?? [];

    const eventRow: BatchExportEventsRow = {
      id: bufferedRow.id,
      traceId: bufferedRow.trace_id,
      traceName: bufferedRow.trace_name,
      type: bufferedRow.type,
      name: bufferedRow.name ?? "",
      startTime: bufferedRow.start_time,
      endTime: bufferedRow.end_time,
      completionStartTime: bufferedRow.completion_start_time,
      environment: bufferedRow.environment,
      version: bufferedRow.version,
      userId: bufferedRow.user_id,
      sessionId: bufferedRow.session_id,
      level: bufferedRow.level,
      statusMessage: bufferedRow.status_message,
      promptName: bufferedRow.prompt_name,
      promptId: bufferedRow.prompt_id,
      promptVersion: bufferedRow.prompt_version,
      modelId: bufferedRow.model_id,
      providedModelName: bufferedRow.provided_model_name,
      modelParameters: parseJsonIfString(bufferedRow.model_parameters),
      usageDetails: parseJsonIfString(bufferedRow.usage_details ?? {}),
      costDetails: parseJsonIfString(bufferedRow.cost_details ?? {}),
      totalCost:
        bufferedRow.total_cost !== null && bufferedRow.total_cost !== undefined
          ? Number(bufferedRow.total_cost)
          : null,
      input: bufferedRow.input,
      output: bufferedRow.output,
      metadata: parseJsonIfString(bufferedRow.metadata ?? {}),
      latencyMs:
        bufferedRow.latency !== null && bufferedRow.latency !== undefined
          ? Number(bufferedRow.latency)
          : null,
      timeToFirstTokenMs:
        bufferedRow.time_to_first_token !== null &&
        bufferedRow.time_to_first_token !== undefined
          ? Number(bufferedRow.time_to_first_token)
          : null,
      tags: parseJsonIfString(bufferedRow.tags ?? []),
      release: bufferedRow.release,
      parentObservationId: bufferedRow.parent_observation_id || null,
      scores: outputScores,
      comments: eventComments,
    };

    return getChunkWithFlattenedScores([eventRow], emptyScoreColumns)[0];
  };

  // Convert async generator to Node.js Readable stream
  let recordsProcessed = 0;

  return Readable.from(
    (async function* () {
      let rowBuffer: EventRow[] = [];
      let eventIds: string[] = [];

      for await (const row of asyncGenerator) {
        rowBuffer.push(row);
        eventIds.push(row.id);

        // Process in batches
        if (rowBuffer.length >= BATCH_SIZE) {
          // Fetch comments for this batch (events are observations)
          const commentsByEvent = await fetchCommentsForExport(
            projectId,
            "OBSERVATION",
            eventIds,
          );

          // Process each row in the buffer
          for (const bufferedRow of rowBuffer) {
            recordsProcessed++;
            if (recordsProcessed % 10000 === 0) {
              logger.info(
                `Streaming events for project ${projectId}: processed ${recordsProcessed} rows`,
              );
            }

            yield processEventRow(bufferedRow, commentsByEvent);
          }

          // Reset buffers
          rowBuffer = [];
          eventIds = [];
        }
      }

      // Process remaining rows in buffer
      if (rowBuffer.length > 0) {
        const commentsByEvent = await fetchCommentsForExport(
          projectId,
          "OBSERVATION",
          eventIds,
        );

        for (const bufferedRow of rowBuffer) {
          recordsProcessed++;
          if (recordsProcessed % 10000 === 0) {
            logger.info(
              `Streaming events for project ${projectId}: processed ${recordsProcessed} rows`,
            );
          }

          yield processEventRow(bufferedRow, commentsByEvent);
        }
      }
    })(),
  );
};

/**
 * Lightweight event stream for batch observation evaluation.
 * Unlike getEventsStream, this:
 * - Uses the "eval" field set (no time/latency/modelId columns)
 * - Skips scores CTE and JOIN
 * - Skips comment fetching
 * - Maps Doris rows to ObservationForEval at the stream boundary
 */
export const getEventsStreamForEval = async (props: {
  projectId: string;
  cutoffCreatedAt: Date;
  filter: FilterCondition[] | null;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  rowLimit?: number;
}): Promise<Readable> => {
  const {
    projectId,
    cutoffCreatedAt,
    filter = [],
    searchQuery,
    searchType,
    rowLimit = env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT,
  } = props;

  // Filter out score and comment filters since they're not relevant for eval
  const eventOnlyFilters = (filter ?? []).filter((f) => {
    const columnDef = eventsTableUiColumnDefinitionsForDoris.find(
      (col) => col.uiTableName === f.column || col.uiTableId === f.column,
    );

    return (
      columnDef?.tableName !== "scores" && columnDef?.tableName !== "comments"
    );
  });

  const eventsFilter = new FilterList(
    createFilterFromFilterState(
      [
        ...eventOnlyFilters,
        {
          column: "startTime",
          operator: "<" as const,
          value: cutoffCreatedAt,
          type: "datetime" as const,
        },
      ],
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedEventsFilter = eventsFilter.apply();

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "observations",
    hasTracesJoin: false,
  });

  // Build the query for Doris - lightweight eval version
  const query = `
    SELECT
      o.span_id AS id,
      o.trace_id,
      o.project_id,
      o.parent_span_id AS parent_observation_id,
      o.type,
      o.name,
      o.environment,
      o.version,
      o.level,
      o.status_message,
      o.trace_name,
      o.user_id,
      o.session_id,
      o.tags,
      o.\`release\` AS \`release\`,
      o.provided_model_name,
      o.model_parameters,
      o.prompt_id,
      o.prompt_name,
      o.prompt_version,
      o.provided_usage_details,
      o.usage_details,
      o.provided_cost_details,
      o.cost_details,
      o.tool_definitions,
      o.tool_calls,
      o.tool_call_names,
      o.input,
      o.output,
      json_object_flatten(o.metadata) AS metadata
    FROM ${tableFor(projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
      AND o.span_id NOT LIKE 't-%'
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
    ORDER BY o.start_time DESC
    LIMIT {rowLimit: Int64}
  `;

  const queryParams = {
    projectId,
    rowLimit,
    ...appliedEventsFilter.params,
    ...search.params,
  };

  // Matches the aliased columns from the "eval" field set + selectIO + selectFieldSet("metadata")
  type EvalEventRow = {
    id: string; // aliased from span_id
    trace_id: string;
    project_id: string;
    parent_observation_id: string | null; // aliased from parent_span_id
    type: string;
    name: string | null;
    environment: string | null;
    version: string | null;
    level: string;
    status_message: string | null;
    trace_name: string | null;
    user_id: string | null;
    session_id: string | null;
    tags: string[];
    release: string | null;
    provided_model_name: string | null;
    model_parameters: unknown;
    prompt_id: string | null;
    prompt_name: string | null;
    prompt_version: number | null;
    provided_usage_details: Record<string, number>;
    usage_details: Record<string, number>;
    provided_cost_details: Record<string, number>;
    cost_details: Record<string, number>;
    tool_definitions: Record<string, unknown>;
    tool_calls: unknown[];
    tool_call_names: string[];
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown> | null;
  };

  const asyncGenerator = queryDorisStream<EvalEventRow>({
    query,
    params: queryParams,
    tags: {
      feature: "batch-eval",
      type: "event",
      kind: "eval",
      projectId,
    },
  });

  // Remap Doris aliases to schema field names.
  // Schema validation is left to the consumer so per-row errors can be handled gracefully.
  return Readable.from(
    (async function* () {
      for await (const row of asyncGenerator) {
        yield {
          ...row,
          span_id: row.id,
          parent_span_id: row.parent_observation_id,
        };
      }
    })(),
  );
};

/**
 * Lightweight event stream for batch add-to-dataset.
 * Only fetches the fields needed for dataset item creation:
 * id, traceId, input, output, metadata.
 */
export const getEventsStreamForDataset = async (props: {
  projectId: string;
  cutoffCreatedAt: Date;
  filter: FilterCondition[] | null;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  rowLimit?: number;
}): Promise<Readable> => {
  const {
    projectId,
    cutoffCreatedAt,
    filter = [],
    searchQuery,
    searchType,
    rowLimit = env.BATCH_EXPORT_ROW_LIMIT,
  } = props;

  const eventOnlyFilters = (filter ?? []).filter((f) => {
    const columnDef = eventsTableUiColumnDefinitionsForDoris.find(
      (col) => col.uiTableName === f.column || col.uiTableId === f.column,
    );

    return (
      columnDef?.tableName !== "scores" && columnDef?.tableName !== "comments"
    );
  });

  const eventsFilter = new FilterList(
    createFilterFromFilterState(
      [
        ...eventOnlyFilters,
        {
          column: "startTime",
          operator: "<" as const,
          value: cutoffCreatedAt,
          type: "datetime" as const,
        },
      ],
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedEventsFilter = eventsFilter.apply();

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "observations",
    hasTracesJoin: false,
  });

  // Build the query for Doris - lightweight dataset version
  const query = `
    SELECT
      o.span_id AS id,
      o.trace_id,
      o.input,
      o.output,
      json_object_flatten(o.metadata) AS metadata
    FROM ${tableFor(projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
      AND o.span_id NOT LIKE 't-%'
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
    ORDER BY o.start_time DESC
    LIMIT {rowLimit: Int64}
  `;

  const queryParams = {
    projectId,
    rowLimit,
    ...appliedEventsFilter.params,
    ...search.params,
  };

  type DatasetEventRow = {
    id: string;
    trace_id: string;
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown> | string | null;
  };

  const asyncGenerator = queryDorisStream<DatasetEventRow>({
    query,
    params: queryParams,
    tags: {
      feature: "batch-add-to-dataset",
      type: "event",
      kind: "dataset",
      projectId,
    },
  });

  return Readable.from(
    (async function* () {
      for await (const row of asyncGenerator) {
        let parsedMetadata = row.metadata;
        if (typeof parsedMetadata === "string") {
          try {
            parsedMetadata = JSON.parse(parsedMetadata);
          } catch {
            // keep raw string if not valid JSON
          }
        }
        yield {
          id: row.id,
          traceId: row.trace_id,
          input: row.input,
          output: row.output,
          metadata: parsedMetadata,
        };
      }
    })(),
  );
};
