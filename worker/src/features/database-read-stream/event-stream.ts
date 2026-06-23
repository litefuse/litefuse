/**
 * Event stream for batch exports.
 * Queries the Doris events table with filters and streams results
 * for efficient batch export processing.
 *
 * The events table is denormalized with trace data already included,
 * so no JOINs are needed for trace-level fields.
 */

import {
  type FilterCondition,
  ScoreDataTypeEnum,
  type TimeFilter,
  type TracingSearchType,
} from "@langfuse/shared";
import {
  getDistinctScoreNames,
  queryDorisStream,
  logger,
  FilterList,
  createFilterFromFilterState,
  eventsTableUiColumnDefinitionsForDoris,
  dorisSearchCondition,
  parseDorisStringArray,
  parseDorisUTCDateTimeFormat,
  zipDorisMetadataArrays,
} from "@langfuse/shared/src/server";
import { Readable } from "stream";
import { env } from "../../env";
import {
  getChunkWithFlattenedScores,
  prepareScoresForOutput,
} from "./getDatabaseReadStream";
import { fetchCommentsForExport } from "./fetchCommentsForExport";
import { type BatchExportEventsRow } from "./types";

const BATCH_SIZE = 1000; // Fetch comments in batches for efficiency

const getEventOnlyFilters = (filter?: FilterCondition[] | null) =>
  (filter ?? []).filter((item) => {
    const columnDef = eventsTableUiColumnDefinitionsForDoris.find(
      (col) => col.uiTableName === item.column || col.uiTableId === item.column,
    );

    return (
      columnDef?.tableName !== "scores" && columnDef?.tableName !== "comments"
    );
  });

const getAppliedEventsFilter = (
  filter: FilterCondition[],
  cutoffCreatedAt: Date,
) =>
  new FilterList(
    createFilterFromFilterState(
      [
        ...filter,
        {
          column: "startTime",
          operator: "<" as const,
          value: cutoffCreatedAt,
          type: "datetime" as const,
        },
      ],
      eventsTableUiColumnDefinitionsForDoris,
    ),
  ).apply();

const parseRecord = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const parseNumericRecord = (value: unknown): Record<string, number> => {
  const raw = parseRecord(value);
  const result: Record<string, number> = {};

  for (const [key, rawValue] of Object.entries(raw)) {
    if (rawValue === null || rawValue === undefined) continue;
    const num = Number(rawValue);
    if (!Number.isNaN(num)) {
      result[key] = num;
    }
  }

  return result;
};

const parseDate = (value: Date | string): Date =>
  value instanceof Date ? value : parseDorisUTCDateTimeFormat(value);

const parseNullableDate = (value: Date | string | null): Date | null =>
  value ? parseDate(value) : null;

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

  const eventOnlyFilters = getEventOnlyFilters(filter);

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
  const appliedEventsFilter = getAppliedEventsFilter(
    eventOnlyFilters,
    cutoffCreatedAt,
  );

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "observations",
    hasTracesJoin: false,
  });

  // Build the query using raw SQL for Doris
  // Doris doesn't have FINAL modifier or LIMIT 1 BY, so we use ROW_NUMBER() for deduplication
  const query = `
    WITH scores_agg AS (
      SELECT
        trace_id,
        observation_id,
        CONCAT('[', GROUP_CONCAT(DISTINCT JSON_OBJECT('name', name, 'value', avg_val, 'dataType', data_type, 'stringValue', COALESCE(string_value, ''))), ']') AS scores_avg,
        CONCAT('[', GROUP_CONCAT(DISTINCT JSON_OBJECT('name', name, 'stringValue', string_value)), ']') AS score_categories_tuples
      FROM (
        SELECT
          trace_id,
          observation_id,
          name,
          avg(value) as avg_val,
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
      o.metadata_names,
      o.metadata_values,
      o.completion_start_time,
      if(o.end_time is null, null, milliseconds_diff(o.end_time, o.start_time)) AS latency,
      if(o.completion_start_time is null, null, milliseconds_diff(o.completion_start_time, o.start_time)) AS time_to_first_token,
      o.tags,
      o.\`release\`,
      o.trace_name,
      o.parent_span_id AS parent_observation_id,
      o.is_deleted,
      s.scores_avg,
      s.score_categories_tuples
    FROM events_full o
    LEFT JOIN scores_agg s ON s.trace_id = o.trace_id AND s.observation_id = o.span_id
    WHERE o.project_id = {projectId: String}
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
      AND o.is_deleted = 0
    ORDER BY o.start_time DESC
    LIMIT {rowLimit: Int64}
  `;

  const queryParams = {
    projectId,
    rowLimit,
    ...appliedEventsFilter.params,
    ...search.params,
  };

  type EventRow = {
    id: string;
    trace_id: string;
    project_id: string;
    start_time: Date | string;
    end_time: Date | string | null;
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
    usage_details: Record<string, number>;
    cost_details: Record<string, number>;
    total_cost: number | null;
    input: unknown;
    output: unknown;
    metadata_names: unknown;
    metadata_values: unknown;
    completion_start_time: Date | string | null;
    latency: number | null;
    time_to_first_token: number | null;
    tags: unknown;
    release: string | null;
    trace_name: string | null;
    parent_observation_id: string | null;
    scores_avg: string | undefined;
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
      bufferedRow.scores_avg ? JSON.parse(bufferedRow.scores_avg) : []
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
      startTime: parseDate(bufferedRow.start_time),
      endTime: parseNullableDate(bufferedRow.end_time),
      completionStartTime: parseNullableDate(bufferedRow.completion_start_time),
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
      modelParameters: bufferedRow.model_parameters,
      usageDetails: bufferedRow.usage_details,
      costDetails: bufferedRow.cost_details,
      totalCost: bufferedRow.total_cost,
      input: bufferedRow.input,
      output: bufferedRow.output,
      metadata: zipDorisMetadataArrays(
        bufferedRow.metadata_names,
        bufferedRow.metadata_values,
      ),
      latencyMs: bufferedRow.latency,
      timeToFirstTokenMs: bufferedRow.time_to_first_token,
      tags: parseDorisStringArray(bufferedRow.tags),
      release: bufferedRow.release,
      parentObservationId: bufferedRow.parent_observation_id,
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

  const eventOnlyFilters = getEventOnlyFilters(filter);
  const appliedEventsFilter = getAppliedEventsFilter(
    eventOnlyFilters,
    cutoffCreatedAt,
  );

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "observations",
    hasTracesJoin: false,
  });

  // Build the query for Doris - lightweight eval version
  const query = `
    SELECT
      o.span_id,
      o.trace_id,
      o.project_id,
      o.start_time,
      o.parent_span_id,
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
      o.\`release\`,
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
      o.experiment_id,
      o.experiment_name,
      o.experiment_description,
      o.experiment_dataset_id,
      o.experiment_item_id,
      o.experiment_item_expected_output,
      o.experiment_item_root_span_id,
      o.input,
      o.output,
      o.metadata_names,
      o.metadata_values
    FROM events_full o
    WHERE o.project_id = {projectId: String}
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
      AND o.is_deleted = 0
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
    span_id: string;
    trace_id: string;
    project_id: string;
    start_time: Date | string;
    parent_span_id: string | null;
    type: string;
    name: string | null;
    environment: string | null;
    version: string | null;
    level: string;
    status_message: string | null;
    trace_name: string | null;
    user_id: string | null;
    session_id: string | null;
    tags: unknown;
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
    tool_definitions: Record<string, unknown> | string | null;
    tool_calls: unknown[];
    tool_call_names: string[];
    experiment_id: string | null;
    experiment_name: string | null;
    experiment_description: string | null;
    experiment_dataset_id: string | null;
    experiment_item_id: string | null;
    experiment_item_expected_output: string | null;
    experiment_item_root_span_id: string | null;
    input: unknown;
    output: unknown;
    metadata_names: unknown;
    metadata_values: unknown;
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
          start_time: parseDate(row.start_time),
          tags: parseDorisStringArray(row.tags),
          tool_calls: parseDorisStringArray(row.tool_calls),
          tool_call_names: parseDorisStringArray(row.tool_call_names),
          provided_usage_details: parseNumericRecord(
            row.provided_usage_details,
          ),
          usage_details: parseNumericRecord(row.usage_details),
          provided_cost_details: parseNumericRecord(row.provided_cost_details),
          cost_details: parseNumericRecord(row.cost_details),
          tool_definitions: parseRecord(row.tool_definitions),
          metadata: zipDorisMetadataArrays(
            row.metadata_names,
            row.metadata_values,
          ),
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

  const eventOnlyFilters = getEventOnlyFilters(filter);
  const appliedEventsFilter = getAppliedEventsFilter(
    eventOnlyFilters,
    cutoffCreatedAt,
  );

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
      o.metadata_names,
      o.metadata_values
    FROM events_full o
    WHERE o.project_id = {projectId: String}
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
      AND o.is_deleted = 0
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
    metadata_names: unknown;
    metadata_values: unknown;
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
        yield {
          id: row.id,
          traceId: row.trace_id,
          input: row.input,
          output: row.output,
          metadata: zipDorisMetadataArrays(
            row.metadata_names,
            row.metadata_values,
          ),
        };
      }
    })(),
  );
};
