/**
 * Event stream for batch exports.
 * Queries the project's Doris `spans_<projectId>` split table (there is no
 * physical `events` table in this model) with filters and streams results
 * for efficient batch export processing.
 *
 * `spans` is denormalized with trace data already included,
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
  eventsTableUiColumnDefinitionsForDoris,
  dorisSearchCondition,
  parseDorisUTCDateTimeFormat,
  tableFor,
  // `release` is a Doris reserved word: the column must be backtick-quoted or
  // the whole statement fails with
  // `no viable alternative at input 'o.release'`.
  dq,
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
 * LITEFUSE: this used to read a physical `events` table, which does not exist
 * here — every project's telemetry lives in its own split tables
 * (`spans_<projectId>` / `traces_scalar_<projectId>`), so the statement now
 * targets `spans_<projectId>`. It is the same table `getEventsStreamForEval`
 * reads: trace roots and observations live in the same table and `is_root`
 * tells them apart, so no `is_root` predicate is added here (the "Is Root
 * Observation" filter column does that when the user asks for it, and this
 * matches the observation read path on `spans`). `spans` is denormalised
 * (trace_name/tags/release/user_id/session_id are columns), so no trace JOIN is
 * needed, and there is no `is_deleted` column to filter on.
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

  // Build filters for events (project_id is handled by the query builder).
  // `eventsTableUiColumnDefinitionsForDoris` is required here: its `select`
  // expressions are Doris SQL over the `o` alias (the ClickHouse mapping emits
  // `e.\`col\`` / ClickHouse-only functions and names a table — `events_proto` —
  // that the Doris filter factory rejects outright).
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

  // Build the query using raw SQL for Doris, reading the project's `spans`
  // split table under the alias `o` — the prefix the Doris filter/search
  // helpers emit.
  // `map<...>` columns are converted with `to_json` (see getEventsStreamForEval)
  // and the VARIANT `metadata` column with `json_object_flatten`.
  // The scores CTE is kept byte-identical to the previous shape on purpose:
  // `scores_avg` is not filtered by `data_type`, so categorical scores already
  // travel through it as `{dataType, stringValue}` and `prepareScoresForOutput`
  // turns them into the categorical score columns. Adding the
  // `score_categories_tuples` aggregate would emit every categorical value twice.
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
      o.span_id AS id,
      o.trace_id AS trace_id,
      o.project_id AS project_id,
      o.start_time AS start_time,
      o.end_time AS end_time,
      o.name AS name,
      o.type AS type,
      o.environment AS environment,
      o.version AS version,
      o.user_id AS user_id,
      o.session_id AS session_id,
      o.level AS level,
      o.status_message AS status_message,
      o.prompt_name AS prompt_name,
      o.prompt_id AS prompt_id,
      o.prompt_version AS prompt_version,
      o.model_id AS model_id,
      o.provided_model_name AS provided_model_name,
      o.model_parameters AS model_parameters,
      to_json(o.usage_details) AS usage_details,
      to_json(o.cost_details) AS cost_details,
      o.total_cost AS total_cost,
      o.input AS input,
      o.output AS output,
      json_object_flatten(o.metadata) AS metadata,
      o.completion_start_time AS completion_start_time,
      if(o.end_time IS NULL, NULL, milliseconds_diff(o.end_time, o.start_time)) AS latency,
      if(o.completion_start_time IS NULL, NULL, milliseconds_diff(o.completion_start_time, o.start_time)) AS time_to_first_token,
      o.tags AS tags,
      o.${dq("release")} AS ${dq("release")},
      o.trace_name AS trace_name,
      if(o.parent_span_id = '', NULL, o.parent_span_id) AS parent_observation_id,
      s.scores_avg,
      s.score_categories
    FROM ${tableFor(projectId, "spans")} o
    LEFT JOIN scores_agg s ON s.trace_id = o.trace_id AND s.observation_id = o.span_id
    WHERE o.project_id = {projectId: String}
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

  // Aliased columns from the `spans` split table (`o`). `metadata` arrives as
  // the JSON text produced by `json_object_flatten`; the `to_json` map columns
  // arrive as objects (Doris reports JSON and the Doris client parses it).
  type EventRow = {
    id: string; // aliased from span_id
    trace_id: string;
    project_id: string;
    start_time: Date;
    end_time: Date | null;
    name: string | null;
    type: string | null;
    environment: string | null;
    version: string | null;
    user_id: string | null;
    session_id: string | null;
    level: string | null;
    status_message: string | null;
    prompt_name: string | null;
    prompt_id: string | null;
    prompt_version: number | null;
    model_id: string | null;
    provided_model_name: string | null;
    model_parameters: unknown;
    usage_details: Record<string, number> | null;
    cost_details: Record<string, number> | null;
    total_cost: number | null;
    input: unknown;
    output: unknown;
    metadata: unknown;
    completion_start_time: Date | null;
    latency: number | null;
    time_to_first_token: number | null;
    tags: string[] | null;
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
      type: bufferedRow.type ?? "",
      name: bufferedRow.name ?? "",
      startTime: bufferedRow.start_time,
      endTime: bufferedRow.end_time,
      completionStartTime: bufferedRow.completion_start_time,
      environment: bufferedRow.environment,
      version: bufferedRow.version,
      userId: bufferedRow.user_id,
      sessionId: bufferedRow.session_id,
      // `spans` stores NULL for several columns the export type declares as
      // non-nullable (no zod defaulting happens on this path), so the documented
      // defaults are filled at the stream boundary — the same treatment
      // getEventsStreamForEval applies for the eval field set.
      level: bufferedRow.level ?? "DEFAULT",
      statusMessage: bufferedRow.status_message,
      promptName: bufferedRow.prompt_name,
      promptId: bufferedRow.prompt_id,
      promptVersion: bufferedRow.prompt_version,
      modelId: bufferedRow.model_id,
      providedModelName: bufferedRow.provided_model_name,
      modelParameters: bufferedRow.model_parameters,
      usageDetails: bufferedRow.usage_details ?? {},
      costDetails: bufferedRow.cost_details ?? {},
      totalCost: bufferedRow.total_cost,
      input: bufferedRow.input,
      output: bufferedRow.output,
      // `json_object_flatten` returns the VARIANT metadata as JSON text.
      metadata: parseMetadataJson(bufferedRow.metadata) ?? {},
      latencyMs: bufferedRow.latency,
      timeToFirstTokenMs: bufferedRow.time_to_first_token,
      tags: bufferedRow.tags ?? [],
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
 *
 * LITEFUSE: this used to read a physical `events` table, which does not exist
 * here — all telemetry lives in per-project split tables (`spans_<projectId>` /
 * `traces_scalar_<projectId>`), so the historic run failed as soon as it tried
 * to read. It now reads `spans` (roots and children live in the same table) with
 * the same alias `o` the Doris filter/search helpers emit. `spans` is
 * denormalised (trace_name/user_id/session_id/tags/release are columns), so no
 * trace join is needed.
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

  // `map<...>` columns are converted with `to_json` so they arrive as objects
  // (Doris' own MAP -> text rendering does not escape quotes and produced
  // invalid JSON for values that are themselves JSON), and the VARIANT
  // `metadata` column is flattened to a JSON string that is parsed below.
  const query = `
    SELECT
      o.span_id AS id,
      o.trace_id AS trace_id,
      o.project_id AS project_id,
      o.parent_span_id AS parent_observation_id,
      o.type AS type,
      o.name AS name,
      o.environment AS environment,
      o.version AS version,
      o.level AS level,
      o.status_message AS status_message,
      o.trace_name AS trace_name,
      o.user_id AS user_id,
      o.session_id AS session_id,
      o.is_root AS is_root,
      o.experiment_item_root_span_id AS experiment_item_root_span_id,
      o.tags AS tags,
      o.${dq("release")} AS ${dq("release")},
      o.provided_model_name AS provided_model_name,
      o.model_parameters AS model_parameters,
      o.prompt_id AS prompt_id,
      o.prompt_name AS prompt_name,
      o.prompt_version AS prompt_version,
      to_json(o.provided_usage_details) AS provided_usage_details,
      to_json(o.usage_details) AS usage_details,
      to_json(o.provided_cost_details) AS provided_cost_details,
      to_json(o.cost_details) AS cost_details,
      to_json(o.tool_definitions) AS tool_definitions,
      o.tool_calls AS tool_calls,
      o.tool_call_names AS tool_call_names,
      o.input AS input,
      o.output AS output,
      json_object_flatten(o.metadata) AS metadata
    FROM ${tableFor(projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
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
    // Numeric root flag as stored in `spans` (1 = trace root); the eval filter
    // registry reads it as `is_root` and normalises it to a boolean.
    is_root: number | null;
    // The experiment item's root span id (a string). The eval filter registry's
    // boolean `isExperimentItemRootSpan` is derived by comparing it with the
    // row's own `span_id`, so the column must be part of this projection.
    experiment_item_root_span_id: string | null;
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
  //
  // LITEFUSE: `spans` stores NULL for a few columns whose eval schema counterpart
  // is non-nullable (zod `.default()` only covers `undefined`, not SQL NULL), so
  // fill the documented defaults here instead of failing those rows during
  // validation: `tags` is NULL for almost every span, `level`/`is_root` can be
  // NULL on older rows and the map columns are NULL when unset.
  return Readable.from(
    (async function* () {
      for await (const row of asyncGenerator) {
        yield {
          ...row,
          span_id: row.id,
          parent_span_id: row.parent_observation_id,
          tags: row.tags ?? [],
          level: row.level ?? "DEFAULT",
          is_root: row.is_root ?? 0,
          provided_usage_details: row.provided_usage_details ?? {},
          usage_details: row.usage_details ?? {},
          provided_cost_details: row.provided_cost_details ?? {},
          cost_details: row.cost_details ?? {},
          tool_definitions: row.tool_definitions ?? {},
          tool_calls: row.tool_calls ?? [],
          tool_call_names: row.tool_call_names ?? [],
          metadata: parseMetadataJson(row.metadata),
        };
      }
    })(),
  );
};

/**
 * `json_object_flatten` returns the VARIANT metadata as JSON text; a malformed
 * value must not abort the whole historic run, so it degrades to `null` (which
 * the eval schema accepts).
 */
function parseMetadataJson(
  metadata: unknown,
): Record<string, unknown> | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "string") {
    return typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : null;
  }
  try {
    const parsed = JSON.parse(metadata);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Lightweight event stream for batch add-to-dataset.
 * Only fetches the fields needed for dataset item creation:
 * id, traceId, input, output, metadata.
 *
 * LITEFUSE: like getEventsStream this used to read a physical `events` table,
 * which does not exist here — it now reads `spans_<projectId>` (alias `o`) with
 * the Doris column definitions, so root-span/experiment-item filters
 * (`isRootObservation` / `hasParentObservation` / `isExperimentItemRootSpan`)
 * resolve to the Doris `o.is_root` / `o.experiment_item_root_span_id` columns.
 * `spans` stores `''` (not NULL) in `parent_span_id` for roots; an
 * `is_root = 1` filter column is what distinguishes them.
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

  // Lightweight dataset version, reading the project's `spans` split table.
  // The VARIANT `metadata` column is flattened to JSON text and parsed below;
  // there is no `is_deleted` column on `spans`.
  const query = `
    SELECT
      o.span_id AS id,
      o.trace_id AS trace_id,
      o.input AS input,
      o.output AS output,
      json_object_flatten(o.metadata) AS metadata
    FROM ${tableFor(projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
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
    id: string; // aliased from span_id
    trace_id: string;
    input: unknown;
    output: unknown;
    metadata: unknown;
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
          metadata: parseMetadataJson(row.metadata),
        };
      }
    })(),
  );
};
