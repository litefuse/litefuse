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
  type ScoreDataTypeType,
  TimeFilter,
  TracingSearchType,
} from "@langfuse/shared";
import {
  getDistinctScoreNames,
  queryDorisStream,
  logger,
  FilterList,
  createFilterFromFilterState,
  eventsTableUiColumnDefinitions,
  dorisSearchCondition,
  parseDorisUTCDateTimeFormat,
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
    const columnDef = eventsTableUiColumnDefinitions.find(
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
      eventsTableUiColumnDefinitions,
    ),
  );

  const appliedEventsFilter = eventsFilter.apply();

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
        GROUP_CONCAT(
          DISTINCT CONCAT(name, ':', COALESCE(string_value, ''))
        ) AS score_categories
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
      e.id,
      e.trace_id,
      e.project_id,
      e.start_time,
      e.end_time,
      e.name,
      e.type,
      e.environment,
      e.version,
      e.user_id,
      e.session_id,
      e.level,
      e.status_message,
      e.prompt_name,
      e.prompt_id,
      e.prompt_version,
      e.model_id,
      e.provided_model_name,
      e.model_parameters,
      e.usage_details,
      e.cost_details,
      e.total_cost,
      e.input,
      e.output,
      e.metadata,
      e.completion_start_time,
      e.latency,
      e.time_to_first_token,
      e.tags,
      e.release,
      e.trace_name,
      e.parent_observation_id,
      e.is_deleted,
      s.scores_avg,
      s.score_categories
    FROM events e
    LEFT JOIN scores_agg s ON s.trace_id = e.trace_id AND s.observation_id = e.id
    WHERE e.project_id = {projectId: String}
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
      AND e.is_deleted = 0
    ORDER BY e.start_time DESC
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
    usage_details: Record<string, number>;
    cost_details: Record<string, number>;
    total_cost: number | null;
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown>;
    completion_start_time: Date | null;
    latency: number | null;
    time_to_first_token: number | null;
    tags: string[];
    release: string | null;
    trace_name: string | null;
    parent_observation_id: string | null;
    scores_avg: string | undefined;
    score_categories: string | undefined;
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
      modelParameters: bufferedRow.model_parameters,
      usageDetails: bufferedRow.usage_details,
      costDetails: bufferedRow.cost_details,
      totalCost: bufferedRow.total_cost,
      input: bufferedRow.input,
      output: bufferedRow.output,
      metadata: bufferedRow.metadata,
      latencyMs: bufferedRow.latency,
      timeToFirstTokenMs: bufferedRow.time_to_first_token,
      tags: bufferedRow.tags,
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

  // Filter out score and comment filters since they're not relevant for eval
  const eventOnlyFilters = (filter ?? []).filter((f) => {
    const columnDef = eventsTableUiColumnDefinitions.find(
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
      eventsTableUiColumnDefinitions,
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
      e.id,
      e.trace_id,
      e.project_id,
      e.parent_observation_id,
      e.type,
      e.name,
      e.environment,
      e.version,
      e.level,
      e.status_message,
      e.trace_name,
      e.user_id,
      e.session_id,
      e.tags,
      e.release,
      e.provided_model_name,
      e.model_parameters,
      e.prompt_id,
      e.prompt_name,
      e.prompt_version,
      e.provided_usage_details,
      e.usage_details,
      e.provided_cost_details,
      e.cost_details,
      e.tool_definitions,
      e.tool_calls,
      e.tool_call_names,
      e.input,
      e.output,
      e.metadata
    FROM events e
    WHERE e.project_id = {projectId: String}
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
      AND e.is_deleted = 0
    ORDER BY e.start_time DESC
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
    const columnDef = eventsTableUiColumnDefinitions.find(
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
      eventsTableUiColumnDefinitions,
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
      e.id,
      e.trace_id,
      e.input,
      e.output,
      e.metadata
    FROM events e
    WHERE e.project_id = {projectId: String}
      ${appliedEventsFilter.query ? `AND ${appliedEventsFilter.query}` : ""}
      ${search.query}
      AND e.is_deleted = 0
    ORDER BY e.start_time DESC
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
    metadata: Record<string, unknown> | null;
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
          metadata: row.metadata,
        };
      }
    })(),
  );
};
