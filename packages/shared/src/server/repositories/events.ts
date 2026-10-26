import { prisma } from "../../db";
import { Observation, EventsObservation, ObservationType } from "../../domain";
import { env } from "../../env";
import {
  InternalServerError,
  InvalidRequestError,
  LangfuseNotFoundError,
} from "../../errors";
import { recordDistribution } from "../instrumentation";
import { logger } from "../logger";
import {
  convertDorisToDomain,
  convertDorisTracesListToDomain,
} from "./traces_converters";
import { FilterState } from "../../types";
import {
  eventsTableNativeUiColumnDefinitionsForDoris,
  eventsTableUiColumnDefinitionsForDoris,
} from "../tableMappings/mapEventsTable";
import { tracesTableUiColumnDefinitionsForDoris } from "../tableMappings/mapTracesTable";
import {
  DEFAULT_RENDERING_PROPS,
  RenderingProps,
  applyInputOutputRendering,
} from "../utils/rendering";
import { ObservationRecordReadType, TraceRecordReadType } from "./definitions";
import type { AnalyticsObservationEvent } from "../analytics-integrations/types";
import {
  ObservationsTableQueryResult,
  ObservationTableQuery,
} from "./observations";
import {
  convertEventsObservation,
  convertObservation,
} from "./observations_converters";
import {
  type EventsObservationPublic,
  type FullEventsObservations,
  type ObservationPriceFields,
} from "../queries/createGenerationsQuery";
import { UiColumnMappings } from "../../tableDefinitions";
import { eventsTableCols } from "../../eventsTable";
import { tracesTableCols } from "../../tableDefinitions/tracesTable";
import { parseMetadataCHRecordToDomain } from "../utils/metadata_conversion";
import { convertDateToAnalyticsDateTime, dq } from "./analyticsDateTime";
import {
  dorisSearchCondition,
  DorisSearchContext,
} from "../queries/doris-sql/search";
import {
  createDorisFilterFromFilterState,
  getDorisProjectIdDefaultFilter,
} from "../queries/doris-sql/factory";
import { DateTimeFilter as DorisDateTimeFilter } from "../queries/doris-sql/doris-filter";
import { OBSERVATIONS_TO_TRACE_INTERVAL } from "./constants";
import { orderByToDorisSQL } from "../queries/doris-sql/orderby-factory";
import {
  EVENTS_CURSOR_KEYSET_WHERE,
  EVENTS_CURSOR_ORDER_BY,
  eventsCursorKeysetParams,
  type EventsCursorPaginationParams,
} from "../queries/doris-sql/eventsCursor";
import {
  queryDoris,
  queryDorisStream,
  commandDoris,
  partialUpdateDoris,
  parseDorisUTCDateTimeFormat,
} from "./doris";
import { FilterList } from "../queries/filter";
import {
  deriveFilters,
  createPublicApiObservationsColumnMapping,
  createPublicApiTracesColumnMapping,
  type ApiColumnMapping,
} from "../queries/public-api-filter-builder";
import { TracingSearchType } from "../../interfaces/search";
import { parseDorisStringArray } from "../utils/dorisArrays";
import { tableFor } from "../doris/tableRouting";

type ObservationsTableQueryResultWitouhtTraceFields = Omit<
  ObservationsTableQueryResult,
  "trace_tags" | "trace_name" | "trace_user_id"
>;

/**
 * Internal helper: enrich observations with model pricing data
 * Uses events-specific converter to include userId and sessionId
 * Supports both V1 (complete observations) and V2 (partial observations with field groups)
 *
 * @param observationRecords - Raw observation records from Doris
 * @param projectId - Project ID for model lookup
 * @param parseIoAsJson - Whether to parse input/output as JSON
 * @param requestedFields - Field groups for V2 API (null = V1 API, returns complete observations)
 */
async function enrichObservationsWithModelData(
  observationRecords: Array<ObservationsTableQueryResultWitouhtTraceFields>,
  projectId: string,
  parseIoAsJson: boolean,
  requestedFields: ObservationFieldGroup[],
): Promise<Array<EventsObservationPublic>>;
async function enrichObservationsWithModelData(
  observationRecords: Array<ObservationsTableQueryResultWitouhtTraceFields>,
  projectId: string,
  parseIoAsJson: boolean,
  requestedFields: null,
): Promise<Array<EventsObservation & ObservationPriceFields>>;
async function enrichObservationsWithModelData(
  observationRecords: Array<ObservationsTableQueryResultWitouhtTraceFields>,
  projectId: string,
  parseIoAsJson: boolean,
  requestedFields: ObservationFieldGroup[] | null,
): Promise<
  Array<(EventsObservation & ObservationPriceFields) | EventsObservationPublic>
> {
  // Determine if this is V1 (complete) or V2 (partial) API
  const isV2 = Array.isArray(requestedFields);
  const effectiveRequestedFields: ObservationFieldGroup[] = isV2
    ? requestedFields.length === 0
      ? [...OBSERVATION_FIELD_GROUPS]
      : requestedFields
    : [];

  // Determine if model enrichment is needed
  // V1 API: always enrich
  // V2 API: only enrich if "model" field group is requested
  const shouldEnrichModel = !isV2 || effectiveRequestedFields.includes("model");

  // Fetch model data if needed
  const models = shouldEnrichModel
    ? await (async () => {
        const uniqueModels: string[] = Array.from(
          new Set(
            observationRecords
              .map((r) => r.internal_model_id)
              .filter((r): r is string => Boolean(r)),
          ),
        );

        return uniqueModels.length > 0
          ? await prisma.model.findMany({
              where: {
                id: {
                  in: uniqueModels,
                },
                OR: [{ projectId: projectId }, { projectId: null }],
              },
              include: {
                Price: true,
              },
            })
          : [];
      })()
    : [];

  return observationRecords.map((o) => {
    const model = shouldEnrichModel
      ? models.find((m) => m.id === o.internal_model_id)
      : null;

    const renderingProps = {
      shouldJsonParse: parseIoAsJson,
      truncated: false,
    };

    // Branch based on API version to use correct overload
    const converted = isV2
      ? convertEventsObservation(o, renderingProps, false)
      : convertEventsObservation(o, renderingProps, true);

    const enriched = {
      ...converted,
      // Use Doris-calculated latency/timeToFirstToken if available, otherwise use what converter calculated
      latency:
        o.latency !== undefined
          ? o.latency
            ? Number(o.latency) / 1000
            : null
          : (converted.latency ?? null),
      timeToFirstToken:
        o.time_to_first_token !== undefined
          ? o.time_to_first_token
            ? Number(o.time_to_first_token) / 1000
            : null
          : (converted.timeToFirstToken ?? null),
      // Add model pricing fields (null if not fetched)
      modelId: model?.id ?? null,
      inputPrice:
        model?.Price?.find((m) => m.usageType === "input")?.price ?? null,
      outputPrice:
        model?.Price?.find((m) => m.usageType === "output")?.price ?? null,
      totalPrice:
        model?.Price?.find((m) => m.usageType === "total")?.price ?? null,
    };

    return isV2
      ? filterObservationFieldsForPublicApi(enriched, effectiveRequestedFields)
      : enriched;
  });
}

async function enrichObservationsWithTraceFields(
  observationRecords: Array<EventsObservation & ObservationPriceFields>,
): Promise<FullEventsObservations> {
  return observationRecords.map((o) => {
    return {
      ...o,
      traceTags: [], // TODO pull from PG
      traceTimestamp: null,
      toolDefinitions: o.toolDefinitions ?? null,
      toolCalls: o.toolCalls ?? null,
      // Compute counts from actual data for events table
      toolDefinitionsCount: o.toolDefinitions
        ? Object.keys(o.toolDefinitions).length
        : null,
      toolCallsCount: o.toolCalls ? o.toolCalls.length : null,
    };
  });
}

/**
 * Internal helper: extract and convert time filter from FilterState
 * Common pattern: find time filter and convert to Doris DateTime format
 */
function extractTimeFilterFromFilterState(
  filter: FilterState,
  tableName: "observations" | "traces" = "observations",
  fieldName: "startTime" | "timestamp" = "startTime",
): string | null {
  const timeFilter = filter.find(
    (f) =>
      f.column === fieldName && (f.operator === ">=" || f.operator === ">"),
  );

  return timeFilter && timeFilter.value
    ? convertDateToAnalyticsDateTime(timeFilter.value as Date)
    : null;
}

/**
 * Column mapping for public API filters on events table (observations)
 */
const PUBLIC_API_EVENTS_COLUMN_MAPPING: ApiColumnMapping[] =
  createPublicApiObservationsColumnMapping(
    "observations",
    "o",
    "parent_span_id",
  );

/**
 * Column mappings for traces aggregated from events table
 */
const PUBLIC_API_TRACES_COLUMN_MAPPING = createPublicApiTracesColumnMapping(
  "traces",
  "t",
);

// For events-based traces, observation fields are aggregated into the traces CTE (with 't' prefix),
// not joined from a separate observations table (with 'o' prefix). We need to remap these.
const TRACES_FROM_EVENTS_UI_COLUMN_DEFINITIONS =
  tracesTableUiColumnDefinitionsForDoris.map((col) => {
    // If this column references the observations table with 'o' prefix,
    // remap it to use 't' prefix since observations are aggregated into traces CTE
    if (col.tableName === "observations") {
      // Replace o. prefix with t. in select (only when followed by identifier)
      // Technically we do not need to deal with the prefix at all,
      // since here these columns are always used inside a CTE.
      const updatedSelect = col.select.replace(/\bo\.([a-z_])/g, "t.$1");

      return {
        ...col,
        tableName: "traces", // Now it's in the traces CTE
        queryPrefix: undefined,
        select: updatedSelect,
      };
    }
    return col;
  });

/**
 * Order by columns for traces CTE (post-aggregation)
 */
const allowedOrderByIds = [
  "timestamp",
  "name",
  "userId",
  "sessionId",
  "environment",
  "version",
  "release",
];
const TRACES_ORDER_BY_COLUMNS = TRACES_FROM_EVENTS_UI_COLUMN_DEFINITIONS.filter(
  (col) => allowedOrderByIds.includes(col.uiTableId),
).map((col) => ({
  ...col,
  // Adjust column names that change after aggregation (start_time -> timestamp)
  select: col.uiTableId === "timestamp" ? "timestamp" : col.select,
  queryPrefix: "t", // Use 't' prefix because we're selecting from traces CTE
}));

// TODO: introduce pagination
export const MAX_OBSERVATIONS_PER_TRACE = 10_000;

export const getObservationsForTraceFromEventsTable = async (params: {
  projectId: string;
  traceId: string;
  timestamp?: Date;
}): Promise<{ observations: FullEventsObservations; totalCount: number }> => {
  const { projectId, traceId, timestamp } = params;

  const filter: FilterState = [
    {
      column: "traceId",
      operator: "=" as const,
      value: traceId,
      type: "string" as const,
    },
  ];

  if (timestamp) {
    filter.push({
      column: "startTime",
      operator: ">=" as const,
      // Equivalent to TRACE_TO_OBSERVATIONS_INTERVAL (INTERVAL 1 HOUR)
      value: new Date(timestamp.getTime() - 60 * 60 * 1000),
      type: "datetime" as const,
    });
  }

  const records =
    await getObservationsFromEventsTableInternal<ObservationsTableQueryResultWitouhtTraceFields>(
      {
        projectId,
        filter,
        orderBy: { column: "startTime", order: "ASC" },
        limit: MAX_OBSERVATIONS_PER_TRACE + 1,
        offset: 0,
        select: "rows",
        tags: { kind: "byTraceId" },
      },
    );

  const totalCount = records.length;

  const withModelData = await enrichObservationsWithModelData(
    records.slice(0, MAX_OBSERVATIONS_PER_TRACE),
    projectId,
    false,
    null,
  );
  const observations = await enrichObservationsWithTraceFields(withModelData);

  return { observations, totalCount };
};

export const getObservationsCountFromEventsTable = async (
  opts: ObservationTableQuery,
) => {
  const count = await getObservationsFromEventsTableInternal<{
    count: string;
  }>({
    ...opts,
    select: "count",
    tags: { kind: "count" },
  });

  return Number(count[0].count);
};

export const getObservationsWithModelDataFromEventsTable = async (
  opts: ObservationTableQuery & EventsCursorPaginationParams,
): Promise<FullEventsObservations> => {
  const observationRecords =
    await getObservationsFromEventsTableInternal<ObservationsTableQueryResultWitouhtTraceFields>(
      {
        ...opts,
        select: "rows",
        tags: { kind: "list" },
      },
    );

  const withModelData: Array<EventsObservation & ObservationPriceFields> =
    await enrichObservationsWithModelData(
      observationRecords,
      opts.projectId,
      false,
      null, // V1 path: always enrich all fields
    );

  return enrichObservationsWithTraceFields(withModelData);
};

async function getObservationsFromEventsTableInternal<T>(
  opts: ObservationTableQuery &
    EventsCursorPaginationParams & {
      select: "count" | "rows";
      tags: Record<string, string>;
    },
): Promise<Array<T>> {
  const {
    projectId,
    filter,
    selectIOAndMetadata,
    renderingProps = DEFAULT_RENDERING_PROPS,
    limit,
    offset,
    orderBy,
    cursorPagination,
    cursor,
  } = opts;

  // Build filter list from filter state using Doris filter factory
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  // Check if we need trace join for search
  const search = dorisSearchCondition(opts.searchQuery, opts.searchType, {
    type: "observations",
  });

  const hasScoresFilter = filter.some((f) =>
    f.column.toLowerCase().includes("score"),
  );

  // Build the base select for observations
  let dorisSelect =
    opts.select === "count"
      ? "count(*) as count"
      : `
        o.span_id as id,
        o.type as type,
        o.project_id as project_id,
        o.name as name,
        o.model_parameters as model_parameters,
        o.start_time as start_time,
        o.end_time as end_time,
        o.trace_id as trace_id,
        o.completion_start_time as completion_start_time,
        o.provided_usage_details as provided_usage_details,
        o.usage_details as usage_details,
        o.provided_cost_details as provided_cost_details,
        o.cost_details as cost_details,
        o.level as level,
        o.environment as environment,
        o.status_message as status_message,
        o.version as version,
        o.parent_span_id as parent_observation_id,
        o.created_at as created_at,
        o.provided_model_name as provided_model_name,
        o.total_cost as total_cost,
        o.prompt_id as prompt_id,
        o.prompt_name as prompt_name,
        o.prompt_version as prompt_version,
        o.model_id as internal_model_id,
        if(o.end_time is null, null, milliseconds_diff(o.end_time, o.start_time)) as latency,
        if(o.completion_start_time is null, null, milliseconds_diff(o.completion_start_time, o.start_time)) as time_to_first_token
      `;

  const dorisSelectString = selectIOAndMetadata
    ? `
      ${dorisSelect},
      ${selectIOAndMetadata ? `o.input, o.output, json_object_flatten(o.metadata) AS metadata` : ""}
    `
    : dorisSelect;

  // Build scores CTE for Doris. See comment in observations.ts for format details.
  // scores_avg: Array<Struct(name, avg_value)> for NumberObjectFilter.
  // score_categories: Array<"name:value"> for CategoryOptionsFilter.
  // Inner subquery averages duplicate score values per (trace, obs, name, ...)
  // before aggregating into the final array.
  const scoresCte = hasScoresFilter
    ? `WITH scores_agg AS (
      SELECT
        trace_id,
        observation_id,
        collect_list(CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN
          struct(name, avg_value) END) AS scores_avg,
        collect_list(CASE WHEN data_type = 'CATEGORICAL' AND string_value IS NOT NULL AND string_value != '' THEN
          CONCAT(name, ':', string_value) ELSE NULL END) AS score_categories
      FROM (
        SELECT
          trace_id,
          observation_id,
          name,
          avg(value) as avg_value,
          string_value,
          data_type,
          comment
        FROM scores
        WHERE project_id = {projectId: String}
        GROUP BY
          trace_id,
          observation_id,
          name,
          string_value,
          data_type,
          comment
      ) tmp
      GROUP BY
        trace_id,
        observation_id
    )`
    : "";

  const dorisOrderBy = orderByToDorisSQL(
    orderBy ? [orderBy] : null,
    eventsTableUiColumnDefinitionsForDoris,
  );

  // Keyset pagination is opt-in (`cursorPagination`) and fixes the ordering:
  // the cursor triple only means anything together with
  // EVENTS_CURSOR_ORDER_BY, so a caller-supplied `orderBy` cannot be honoured on
  // this path. Same contract as the public API observations cursor
  // (applyCursorPagination below). Absent the flag, the query is byte-identical
  // to the pre-cursor offset path.
  const isCursorPagination = Boolean(cursorPagination);
  const keysetParams =
    isCursorPagination && cursor ? eventsCursorKeysetParams(cursor) : {};

  // A cursor page never carries an OFFSET — the keyset predicate IS the cursor.
  // limit/offset are interpolated rather than bound (as on the offset path), so
  // clamp `limit` to a non-negative integer: it arrives from paginationZod,
  // whose coercion does not enforce integrality.
  const dorisLimit = isCursorPagination
    ? limit !== undefined && Number.isFinite(limit)
      ? `LIMIT ${Math.max(0, Math.trunc(limit))}`
      : ""
    : limit !== undefined && offset !== undefined
      ? `LIMIT ${limit} OFFSET ${offset}`
      : "";

  const query = `
      ${scoresCte}
      SELECT ${dorisSelectString}
      FROM ${tableFor(projectId, "spans")} o
               ${hasScoresFilter ? "LEFT JOIN scores_agg AS s ON s.trace_id = o.trace_id and s.observation_id = o.span_id" : ""}
      WHERE ${appliedFilter.query}
                   ${search.query}
                   ${isCursorPagination && cursor ? EVENTS_CURSOR_KEYSET_WHERE : ""}
        ${isCursorPagination ? EVENTS_CURSOR_ORDER_BY : dorisOrderBy}
        ${dorisLimit};`;

  const res = await queryDoris<T>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
      ...search.params,
      ...keysetParams,
    },
    tags: {
      ...(opts.tags ?? {}),
      feature: "tracing",
      type: "events",
      projectId,
    },
  });

  if (selectIOAndMetadata && opts.select === "rows") {
    return res.map((r) => {
      const row = r as Record<string, unknown>;
      row.metadata =
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : (row.metadata ?? {});
      return row as T;
    });
  }

  return res;
}

export const getObservationByIdFromEventsTable = async ({
  id,
  projectId,
  fetchWithInputOutput = false,
  startTime,
  type,
  traceId,
  renderingProps = DEFAULT_RENDERING_PROPS,
}: {
  id: string;
  projectId: string;
  fetchWithInputOutput?: boolean;
  startTime?: Date;
  type?: ObservationType;
  traceId?: string;
  renderingProps?: RenderingProps;
}) => {
  const records = await getObservationByIdFromEventsTableInternal({
    id,
    projectId,
    fetchWithInputOutput,
    startTime,
    type,
    traceId,
  });
  const mapped = records.map((record) => ({
    ...convertObservation(record, renderingProps),
    // Carry the precomputed compact preview (input_trim/output_trim, migration
    // 0037) so observations.byId can serve it for verbosity "compact" (the
    // observations-list cell) without parsing the full Variant.
    input_trim: (record as { input_trim?: string | null }).input_trim ?? null,
    output_trim:
      (record as { output_trim?: string | null }).output_trim ?? null,
    // Retrieval-only passthrough of the experiment item's root span id: the
    // evaluators-v2 test-run projection (`getObservationForEvalById`) derives
    // upstream's boolean `isExperimentItemRootSpan` from
    // "span_id === experiment_item_root_span_id" and cannot do so if the read
    // drops the column. `convertObservation` has no mapping for it, so it is
    // carried through here like the trimmed previews above.
    experiment_item_root_span_id:
      (record as { experiment_item_root_span_id?: string | null })
        .experiment_item_root_span_id ?? null,
  }));

  mapped.forEach((observation) => {
    recordDistribution(
      "langfuse.query_by_id_age",
      new Date().getTime() - observation.startTime.getTime(),
      {
        table: "events",
      },
    );
  });
  if (mapped.length === 0) {
    throw new LangfuseNotFoundError(`Observation with id ${id} not found`);
  }

  if (mapped.length > 1) {
    logger.error(
      `Multiple observations found for id ${id} and project ${projectId}`,
    );
    throw new InternalServerError(
      `Multiple observations found for id ${id} and project ${projectId}`,
    );
  }
  return mapped.shift();
};

async function getObservationByIdFromEventsTableInternal({
  id,
  projectId,
  fetchWithInputOutput = false,
  startTime,
  type,
  traceId,
}: {
  id: string;
  projectId: string;
  fetchWithInputOutput?: boolean;
  startTime?: Date;
  type?: ObservationType;
  traceId?: string;
}) {
  const query = `
    SELECT
      span_id AS id,
      trace_id,
      project_id,
      type,
      parent_span_id AS parent_observation_id,
      environment,
      start_time,
      end_time,
      name,
      level,
      status_message,
      version,
      ${fetchWithInputOutput ? "input, output," : ""}
      input_trim,
      output_trim,
      provided_model_name,
      model_id AS internal_model_id,
      model_parameters,
      provided_usage_details,
      usage_details,
      provided_cost_details,
      cost_details,
      total_cost,
      completion_start_time,
      prompt_id,
      prompt_name,
      prompt_version,
      created_at,
      -- Added for the evaluators-v2 eval projection: the item's root span id
      -- (upstream's boolean isExperimentItemRootSpan) and the tool-call arrays
      -- (upstream's numeric toolCalls count). Both are plain reads of existing
      -- columns; nothing is written.
      experiment_item_root_span_id,
      tool_calls,
      tool_call_names
    FROM ${tableFor(projectId, "spans")}
    WHERE project_id = {projectId: String}
    AND span_id = {id: String}
    ${startTime ? `AND DATE(start_time) = DATE({startTime: DateTime})` : ""}
    ${type ? `AND type = {type: String}` : ""}
    ${traceId ? `AND trace_id = {traceId: String}` : ""}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const rawRecords = await queryDoris<any>({
    query,
    params: {
      id,
      projectId,
      ...(startTime
        ? { startTime: convertDateToAnalyticsDateTime(startTime) }
        : {}),
      ...(type ? { type } : {}),
      ...(traceId ? { traceId } : {}),
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "byId",
      projectId,
    },
  });

  return rawRecords;
}

/**
 * Get a trace by ID from the events table.
 * Compatible with getTraceById but queries the Doris traces table instead.
 */
export const getTraceByIdFromEventsTable = async ({
  traceId,
  projectId,
  timestamp,
  renderingProps = DEFAULT_RENDERING_PROPS,
}: {
  traceId: string;
  projectId: string;
  timestamp?: Date;
  renderingProps?: RenderingProps;
}) => {
  // Scalar point read: every selected field is a trace scalar on
  // traces_scalar (one row per trace — migration 0039; (project_id, id) is
  // the unique-key prefix and id the distribution column, so this is a
  // single-tablet lookup). traces_scalar's metadata is a native Map — no
  // metadata_names/values zip — and `name` is the explicit trace name,
  // matching what getTraceById (the migrated sibling in traces.ts) returns.
  // Falls back to the spans root row when the scalar row is missing
  // (a trace still in flight — OTel exports the root span last — or data
  // predating traces_scalar), mirroring getTraceById's fallback.
  const scalarQuery = `
    SELECT
      id,
      name,
      user_id,
      json_object_flatten(metadata) AS metadata,
      ${dq("release")},
      version,
      project_id,
      environment,
      ${dq("public")},
      bookmarked,
      tags,
      session_id,
      start_time AS \`timestamp\`,
      created_at,
      updated_at
    FROM ${tableFor(projectId, "traces_scalar")}
    WHERE project_id = {projectId: String}
    AND id = {traceId: String}
    ${timestamp ? `AND DATE(start_time) = DATE({timestamp: DateTime})` : ""}
    -- start_time is part of the unique key: a root span re-delivered with a
    -- corrected start_time yields a SECOND scalar row for the same trace, so
    -- pick the newest deterministically (mirrors the fallback's ordering).
    ORDER BY start_time DESC
    LIMIT 1
  `;

  const fallbackQuery = `
    SELECT
      t.trace_id AS id,
      t.name,
      t.user_id,
      json_object_flatten(t.metadata) AS metadata,
      t.${dq("release")},
      t.version,
      t.project_id,
      t.environment,
      t.${dq("public")},
      t.bookmarked,
      t.tags,
      t.session_id,
      t.start_time AS \`timestamp\`,
      t.created_at
    FROM ${tableFor(projectId, "spans")} t
    WHERE t.project_id = {projectId: String}
    AND t.trace_id = {traceId: String}
    AND t.is_root = 1
    ${timestamp ? `AND DATE(t.start_time) = DATE({timestamp: DateTime})` : ""}
    ORDER BY t.start_time DESC
    LIMIT 1
  `;

  const params = {
    projectId,
    traceId,
    ...(timestamp
      ? { timestamp: convertDateToAnalyticsDateTime(timestamp) }
      : {}),
  };

  let rawRecords = await queryDoris<
    Omit<TraceRecordReadType, "metadata"> & {
      metadata?: unknown;
    }
  >({
    query: scalarQuery,
    params,
    tags: {
      feature: "tracing",
      type: "trace",
      kind: "byId-scalar",
      projectId,
    },
  });
  if (rawRecords.length === 0) {
    rawRecords = await queryDoris({
      query: fallbackQuery,
      params,
      tags: {
        feature: "tracing",
        type: "trace",
        kind: "byId",
        projectId,
      },
    });
  }

  const records: TraceRecordReadType[] = rawRecords.map((r) => ({
    ...r,
    metadata: r.metadata,
  })) as TraceRecordReadType[];

  const res = records.map((record) =>
    convertDorisToDomain(record, renderingProps),
  );

  res.forEach((trace) => {
    recordDistribution(
      "langfuse.query_by_id_age",
      new Date().getTime() - trace.timestamp.getTime(),
      {
        table: "events",
      },
    );
  });

  return res.shift();
};

/**
 * Field groups for selective field fetching in v2 observations API
 *
 * - core: Always included (cursor-required fields)
 * - basic, time, io, metadata, model, usage, prompt, metrics, trace_context: Optional groups
 */
export const OBSERVATION_FIELD_GROUPS = [
  "core", // Always included: id, traceId, startTime, endTime, projectId, parentObservationId, type
  "basic", // name, level, statusMessage, version, environment, bookmarked, public, userId, sessionId
  "time", // completionStartTime, createdAt
  "io", // input, output
  "metadata", // metadata
  "model", // providedModelName, internalModelId, modelParameters
  "usage", // usageDetails, costDetails, totalCost, usagePricingTierName
  "prompt", // promptId, promptName, promptVersion
  "metrics", // latency, timeToFirstToken
  "trace_context", // tags, release, traceName
] as const;

export type ObservationFieldGroup = (typeof OBSERVATION_FIELD_GROUPS)[number];

const OBSERVATION_CORE_FIELDS = [
  "id",
  "traceId",
  "startTime",
  "endTime",
  "projectId",
  "parentObservationId",
  "type",
] as const;

const OBSERVATION_FIELDS_BY_GROUP: Record<
  ObservationFieldGroup,
  readonly string[]
> = {
  core: OBSERVATION_CORE_FIELDS,
  basic: [
    "name",
    "level",
    "statusMessage",
    "version",
    "environment",
    "bookmarked",
    "public",
    "userId",
    "sessionId",
  ],
  // No updatedAt: spans is append-only (no updated_at column), so the events
  // path never has it — don't advertise a field the response can't deliver.
  time: ["completionStartTime", "createdAt"],
  io: ["input", "output"],
  metadata: ["metadata"],
  model: [
    "model",
    "internalModelId",
    "modelParameters",
    "modelId",
    "inputPrice",
    "outputPrice",
    "totalPrice",
  ],
  usage: [
    "usageDetails",
    "costDetails",
    "providedCostDetails",
    "inputUsage",
    "outputUsage",
    "totalUsage",
    "inputCost",
    "outputCost",
    "totalCost",
    "usagePricingTierId",
    "usagePricingTierName",
  ],
  prompt: ["promptId", "promptName", "promptVersion"],
  metrics: ["latency", "timeToFirstToken"],
  trace_context: ["traceName", "tags", "release"],
};

export function filterObservationFieldsForPublicApi(
  observation: EventsObservationPublic,
  requestedFields: ObservationFieldGroup[],
): EventsObservationPublic {
  const effectiveFields =
    requestedFields.length > 0 ? requestedFields : OBSERVATION_FIELD_GROUPS;

  const allowedFields = new Set<string>(OBSERVATION_CORE_FIELDS);
  for (const group of effectiveFields) {
    for (const field of OBSERVATION_FIELDS_BY_GROUP[group]) {
      allowedFields.add(field);
    }
  }

  return Object.fromEntries(
    Object.entries(observation).filter(([key]) => allowedFields.has(key)),
  ) as EventsObservationPublic;
}

export type PublicApiObservationsQuery = {
  projectId: string;
  page: number;
  limit: number;
  traceId?: string;
  userId?: string;
  name?: string;
  type?: string;
  level?: string;
  parentObservationId?: string;
  fromStartTime?: string;
  toStartTime?: string;
  version?: string;
  environment?: string | string[];
  advancedFilters?: FilterState;
  parseIoAsJson?: boolean;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  cursor?: {
    lastStartTimeTo: Date;
    lastTraceId: string;
    lastId: string;
  };
  fields?: ObservationFieldGroup[] | null;
  /**
   * Metadata keys to expand (return full non-truncated values).
   * - null/undefined: use truncated metadata (default behavior)
   * - string[]: expand specified keys (or all keys if empty array)
   */
  expandMetadataKeys?: string[] | null;
};

/**
 * Build observation query components for Doris using direct SQL.
 *
 * Exported so unit tests can inspect the generated SQL + params directly
 * without standing up a Doris cluster. Not part of the public API surface.
 */
export function buildObservationsQueryDoris(opts: PublicApiObservationsQuery): {
  baseQuery: string;
  params: Record<string, unknown>;
} {
  const { projectId, advancedFilters, ...filterParams } = opts;

  // Merge simple-param filters (fromStartTime, toStartTime, traceId, userId,
  // name, type, level, parentObservationId, version, environment) with the
  // advanced JSON filter via the shared deriveFilters helper. The simple
  // params live in PUBLIC_API_EVENTS_COLUMN_MAPPING (defined above in this
  // file); userId is routed to the traces table with prefix "t", everything
  // else stays on observations/o. deriveFilters lets advancedFilters override
  // simple params on the same field.
  const observationsFilter = deriveFilters(
    { ...filterParams, projectId },
    PUBLIC_API_EVENTS_COLUMN_MAPPING,
    advancedFilters,
    eventsTableUiColumnDefinitionsForDoris,
  );

  // userId references t.user_id; JOIN ${tableFor(projectId, "spans")} as the root-span table
  // only when at least one filter targets the traces side.
  const hasTraceFilter = observationsFilter.some((f) => f.table === "traces");

  const appliedFilter = observationsFilter.apply();

  // Build search condition
  const search = dorisSearchCondition(opts.searchQuery, opts.searchType, {
    type: "observations",
  });

  const baseQuery = `
    SELECT
      o.span_id AS id,
      o.type,
      o.project_id,
      o.name,
      o.start_time,
      o.end_time,
      o.trace_id,
      o.parent_span_id AS parent_observation_id,
      o.environment,
      o.level,
      o.status_message,
      o.version,
      o.input,
      o.output,
      o.input_trim,
      o.output_trim,
      json_object_flatten(o.metadata) AS metadata,
      o.prompt_id,
      o.prompt_name,
      o.prompt_version,
      o.model_id AS internal_model_id,
      o.provided_model_name,
      o.usage_details,
      o.cost_details,
      o.total_cost,
      o.usage_pricing_tier_name,
      o.completion_start_time,
      o.created_at,
      o.trace_name,
      o.tags,
      o.${dq("release")} AS \`release\`,
      o.bookmarked,
      o.${dq("public")} AS \`public\`,
      o.user_id,
      o.session_id
    FROM ${tableFor(projectId, "spans")} o
    ${hasTraceFilter ? `JOIN ${tableFor(projectId, "spans")} t ON o.trace_id = t.trace_id AND t.project_id = o.project_id AND t.is_root = 1` : ""}
    WHERE o.project_id = {projectId: String}
      ${appliedFilter.query ? `AND ${appliedFilter.query}` : ""}
    ${search.query}
  `;

  return {
    baseQuery,
    params: {
      projectId,
      ...appliedFilter.params,
      ...search.params,
    },
  };
}

// The stable ORDER BY used by both pagination strategies is
// EVENTS_CURSOR_ORDER_BY (declared in ../queries/doris-sql/eventsCursor):
// without those secondary sort keys rows with an identical start_time can come
// back in any order from Doris on each query — under cursor pagination that
// duplicates / skips rows on page boundaries; under offset pagination it makes
// page N+1 repeat rows already returned in page N.

function applyOffsetPagination(
  opts: PublicApiObservationsQuery,
  baseQuery: string,
  params: Record<string, unknown>,
): { query: string; params: Record<string, unknown> } {
  const offset = (opts.page - 1) * opts.limit;
  return {
    query: `${baseQuery} ${EVENTS_CURSOR_ORDER_BY} LIMIT ${opts.limit} OFFSET ${offset}`,
    params,
  };
}

function applyCursorPagination(
  opts: PublicApiObservationsQuery,
  baseQuery: string,
  params: Record<string, unknown>,
): { query: string; params: Record<string, unknown> } {
  if (!opts.cursor) {
    return {
      query: `${baseQuery} ${EVENTS_CURSOR_ORDER_BY} LIMIT ${opts.limit + 1}`,
      params,
    };
  }

  // Keyset predicate + stable ordering live in EVENTS_CURSOR_KEYSET_WHERE /
  // EVENTS_CURSOR_ORDER_BY so this path and the internal events-list cursor
  // (getObservationsFromEventsTableInternal) can never drift apart.
  return {
    query: `${baseQuery}
      ${EVENTS_CURSOR_KEYSET_WHERE}
      ${EVENTS_CURSOR_ORDER_BY}
      LIMIT ${opts.limit + 1}`,
    params: {
      ...params,
      ...eventsCursorKeysetParams(opts.cursor),
    },
  };
}

async function getObservationsRowsFromDoris<T>(
  projectId: string,
  query: string,
  params: Record<string, unknown>,
  operationName: string = "getObservationsFromEventsTableForPublicApi_rows",
): Promise<Array<T>> {
  const res = await queryDoris<T>({
    query,
    params,
    tags: {
      feature: "tracing",
      type: "events",
      kind: "publicApiRows",
      projectId,
    },
  });
  return res.map((r) => {
    const row = r as Record<string, unknown>;
    if ("metadata" in row) {
      row.metadata =
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : (row.metadata ?? {});
    }
    return row as T;
  });
}

/**
 * Internal function to get count of observations from events table for public API.
 */
async function getObservationsCountFromEventsTableForPublicApiInternal(
  opts: PublicApiObservationsQuery,
): Promise<Array<{ count: string }>> {
  const { projectId, advancedFilters, ...filterParams } = opts;

  // Merge simple-param filters with the advanced JSON filter the same way
  // buildObservationsQueryDoris does, so v1 totalItems respects fromStartTime
  // /traceId/userId/etc. instead of returning the unfiltered project count.
  const observationsFilter = deriveFilters(
    { ...filterParams, projectId },
    PUBLIC_API_EVENTS_COLUMN_MAPPING,
    advancedFilters,
    eventsTableUiColumnDefinitionsForDoris,
  );

  const hasTraceFilter = observationsFilter.some((f) => f.table === "traces");
  const appliedFilter = observationsFilter.apply();

  // Build search condition
  const search = dorisSearchCondition(opts.searchQuery, opts.searchType, {
    type: "observations",
  });

  const query = `
    SELECT count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    ${hasTraceFilter ? `JOIN ${tableFor(projectId, "spans")} t ON o.trace_id = t.trace_id AND t.project_id = o.project_id AND t.is_root = 1` : ""}
    WHERE o.project_id = {projectId: String}
      ${appliedFilter.query ? `AND ${appliedFilter.query}` : ""}
    ${search.query}
  `;

  return await queryDoris<{ count: string }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
      ...search.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "publicApiCount",
      projectId,
    },
  });
}

/**
 * V1 API: Get observations list from events table for public API
 * Returns complete observations with all fields for transformDbToApiObservation
 */
export const getObservationsFromEventsTableForPublicApi = async (
  opts: Omit<PublicApiObservationsQuery, "fields">,
): Promise<Array<Observation & ObservationPriceFields>> => {
  const { baseQuery, params } = buildObservationsQueryDoris(opts);
  const { query } = applyOffsetPagination(opts, baseQuery, params);

  const observationRecords =
    await getObservationsRowsFromDoris<ObservationsTableQueryResultWitouhtTraceFields>(
      opts.projectId,
      query,
      params,
    );

  return await enrichObservationsWithModelData(
    observationRecords,
    opts.projectId,
    opts.parseIoAsJson ?? true,
    null,
  );
};

/**
 * V2 API: Get observations list from events table for public API
 * Returns partial observations based on requested field groups
 */
export const getObservationsV2FromEventsTableForPublicApi = async (
  opts: PublicApiObservationsQuery & { fields: ObservationFieldGroup[] },
): Promise<Array<EventsObservationPublic>> => {
  const { baseQuery, params: baseParams } = buildObservationsQueryDoris(opts);
  // applyCursorPagination adds lastStartTime / lastTraceId / lastId to the
  // returned params map — must use *those* params, not baseParams, otherwise
  // the {lastStartTime: String} placeholders go to Doris unsubstituted.
  const { query, params } = applyCursorPagination(opts, baseQuery, baseParams);

  const records =
    await getObservationsRowsFromDoris<ObservationsTableQueryResultWitouhtTraceFields>(
      opts.projectId,
      query,
      params,
    );

  return await enrichObservationsWithModelData(
    records,
    opts.projectId,
    false,
    opts.fields,
  );
};

/**
 * Get count of observations from events table for public API.
 */
export const getObservationsCountFromEventsTableForPublicApi = async (
  opts: PublicApiObservationsQuery,
): Promise<number> => {
  const countResult =
    await getObservationsCountFromEventsTableForPublicApiInternal(opts);
  return Number(countResult[0].count);
};

type PublicApiTracesQuery = {
  projectId: string;
  page: number;
  limit: number;
  userId?: string;
  name?: string;
  tags?: string | string[];
  sessionId?: string;
  version?: string;
  release?: string;
  environment?: string | string[];
  fromTimestamp?: string;
  toTimestamp?: string;
  fields?: string[];
  advancedFilters?: FilterState;
  orderBy?: { column: string; order: "ASC" | "DESC" } | null;
};

// traces_scalar (one row per trace — migration 0039) exposed under
// spans-compatible column names, so the shared traces filter/orderBy
// mappings (t.trace_id, t.trace_name, t.start_time, …) apply unchanged. Every
// column the public traces API projects or filters on is a trace scalar, so
// the list/count queries read this table instead of `is_root = 1` spans
// scans. traces_scalar stores NULL where spans root rows store ''
// (name/user_id/session_id/release/version) — COALESCE back to '' HERE so
// both filters and the serialized response keep the upstream ''-for-unset
// convention: negative operators (does-not-contain / none-of) must keep
// matching unset rows, which raw NULL columns silently drop (NULL predicates
// are never true). Costs the inverted-index probe on these five columns —
// correctness over index; see the filter-factory NULL-aware-predicate
// follow-up.
const tracesScalarAsTForPublicApi = (projectId: string) => `(
      SELECT
        project_id,
        id AS trace_id,
        COALESCE(name, '') AS trace_name,
        COALESCE(name, '') AS name,
        COALESCE(user_id, '') AS user_id,
        COALESCE(session_id, '') AS session_id,
        environment,
        tags,
        metadata,
        start_time,
        bookmarked,
        ${dq("public")},
        COALESCE(${dq("release")}, '') AS ${dq("release")},
        COALESCE(version, '') AS version,
        created_at,
        updated_at
      FROM ${tableFor(projectId, "traces_scalar")}
    ) t`;

// The traces_scalar-backed query only exposes trace-scalar columns. Advanced
// filters on observation/score columns (level, latency, totalCost, scores_avg,
// …) would reference aliases that do not exist and fail at parse time — reject
// them up front with a clear 400 instead. Mirrors rejectNonTracesFilters on
// the legacy web public-traces path.
function rejectNonTracesPublicApiFilters(filterList: FilterList): void {
  const offending: Array<{ table?: string; field: string }> = [];
  filterList.forEach((f) => {
    if (f.table && f.table !== "traces") offending.push(f);
  });
  if (offending.length > 0) {
    const desc = offending
      .map((f) => `'${f.field}' (table: ${f.table})`)
      .join(", ");
    throw new InvalidRequestError(
      `Filtering on ${desc} is not supported via the public traces API on the Doris backend. Only columns on the traces table are supported.`,
    );
  }
}

/**
 * Internal implementation for public API traces queries.
 * Reads traces_scalar (one row per trace) — every projected/filterable column
 * is a trace scalar. List and count derive the same FilterList (simple query
 * params + advanced JSON filters, advanced wins) so their filtering stays
 * consistent.
 */
async function getTracesFromEventsTableForPublicApiInternal<T>(
  opts: PublicApiTracesQuery & { select: "rows" | "count" },
): Promise<Array<T>> {
  const { projectId, page, limit, orderBy } = opts;

  const filter = deriveFilters(
    opts,
    PUBLIC_API_TRACES_COLUMN_MAPPING,
    opts.advancedFilters,
    tracesTableUiColumnDefinitionsForDoris,
    tracesTableCols,
  );
  rejectNonTracesPublicApiFilters(filter);
  const appliedFilter = filter.apply();
  const whereClause = `
    WHERE t.project_id = {projectId: String}
    ${filter.length() > 0 ? `AND ${appliedFilter.query}` : ""}`;

  // Build order by clause
  let orderByClause = "ORDER BY t.project_id DESC, t.start_time DESC";
  if (orderBy) {
    orderByClause = orderByToDorisSQL(
      orderBy ? [orderBy] : [],
      tracesTableUiColumnDefinitionsForDoris,
    );
  }

  if (opts.select === "count") {
    const countQuery = `
      SELECT count(*) as count
      FROM ${tracesScalarAsTForPublicApi(projectId)}
      ${whereClause}
    `;

    const result = await queryDoris<{ count: string }[]>({
      query: countQuery,
      params: { projectId, ...appliedFilter.params },
      tags: {
        feature: "tracing",
        type: "traces",
        kind: "publicApiCount",
        projectId,
      },
    });
    return result as Array<T>;
  }

  const query = `
    SELECT
      t.trace_id AS id,
      t.project_id,
      t.start_time AS \`timestamp\`,
      t.name,
      t.environment,
      t.session_id,
      t.user_id,
      t.version,
      t.created_at,
      t.updated_at,
      t.tags,
      t.bookmarked,
      t.${dq("public")},
      t.${dq("release")},
      CONCAT('/project/', t.project_id, '/traces/', t.trace_id) as htmlPath
    FROM ${tracesScalarAsTForPublicApi(projectId)}
    ${whereClause}
    ${orderByClause}
    LIMIT {limit: Int32}
    OFFSET {offset: Int32}
  `;

  const result = await queryDoris<T>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
      limit,
      offset: (page - 1) * limit,
    },
    tags: {
      feature: "tracing",
      type: "traces",
      kind: "publicApiRows",
      projectId,
    },
  });

  return result;
}

/**
 * Get traces list from events table for public API.
 * Aggregates events by trace_id to rebuild traces with observation metrics.
 */
export const getTracesFromEventsTableForPublicApi = async (
  opts: PublicApiTracesQuery,
): Promise<Array<any>> => {
  const requestedFields = opts.fields ?? [
    "core",
    "io",
    "scores",
    "observations",
    "metrics",
  ];
  const includeScores = requestedFields.includes("scores");
  const includeObservations = requestedFields.includes("observations");
  const includeMetrics = requestedFields.includes("metrics");

  const result = await getTracesFromEventsTableForPublicApiInternal<any>({
    ...opts,
    select: "rows",
  });

  // Convert Doris format to domain format and handle field groups
  return convertDorisTracesListToDomain(result, {
    scores: includeScores,
    observations: includeObservations,
    metrics: includeMetrics,
  });
};

/**
 * Get count of traces from events table for public API.
 * Uses same aggregation as list query to ensure consistent filtering.
 */
export const getTracesCountFromEventsTableForPublicApi = async (
  opts: PublicApiTracesQuery,
): Promise<number> => {
  const countResult = await getTracesFromEventsTableForPublicApiInternal<{
    count: string;
  }>({
    ...opts,
    select: "count",
  });
  return Number(countResult[0].count);
};

type UpdateableEventFields = {
  bookmarked?: boolean;
  public?: boolean;
  tags?: string[];
};

/**
 * Update events in Doris based on selector and updates provided.
 * Selector can filter by spanIds, traceIds, and rootOnly flag.
 * Both spanIds / traceIds are used only when defined and non-empty.
 * E.g. `{ traceIds: [...] }` will only filter by traceIds, while
 * `{ spanIds: [...], traceIds: [...] }` will filter by both.
 *
 * @deprecated spans is a DUPLICATE-model table (migration 0037) and
 * Doris does not support UPDATE on duplicate tables — calling this now fails
 * at the database. Trace-level mutable flags (bookmarked/public/tags) live in
 * traces_scalar instead; no production call sites remain.
 */
export const updateEvents = async (
  projectId: string,
  selector: { spanIds?: string[]; traceIds?: string[]; rootOnly?: boolean },
  updates: UpdateableEventFields,
): Promise<void> => {
  if (Object.keys(updates).length === 0) {
    // Nothing to update
    return;
  }

  // Build where conditions
  const where: Record<string, unknown> = { project_id: projectId };
  if (selector.spanIds && selector.spanIds.length > 0) {
    where.span_id = selector.spanIds;
  }
  if (selector.traceIds && selector.traceIds.length > 0) {
    where.trace_id = selector.traceIds;
  }
  if (selector.rootOnly === true) {
    where.parent_span_id = "";
  }

  await partialUpdateDoris({
    table: "spans",
    where,
    set: updates,
  });
};

/**
 * Get grouped provided model names from events table
 * Used for filter options
 */
export const getEventsGroupedByModel = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.provided_model_name as name, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.provided_model_name IS NOT NULL
    AND length(o.provided_model_name) > 0
    GROUP BY o.provided_model_name
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ name: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ model: r.name, count: Number(r.count) }));
};

/**
 * Get grouped model IDs from events table
 * Used for filter options
 */
export const getEventsGroupedByModelId = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.model_id as modelId, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.model_id IS NOT NULL
    AND length(o.model_id) > 0
    GROUP BY o.model_id
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ modelId: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ modelId: r.modelId, count: Number(r.count) }));
};

/**
 * Get grouped observation names from events table
 * Used for filter options
 */
export const getEventsGroupedByName = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.name as name, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.name IS NOT NULL
    AND length(o.name) > 0
    GROUP BY o.name
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ name: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ name: r.name, count: Number(r.count) }));
};

/**
 * Get grouped trace names from events table
 * Used for filter options
 */
export const getEventsGroupedByTraceName = async (
  projectId: string,
  filter: FilterState,
  opts?: { extraWhereRaw?: string },
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.trace_name as traceName, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.trace_name IS NOT NULL
    AND length(o.trace_name) > 0
    GROUP BY o.trace_name
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ traceName: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ traceName: r.traceName, count: Number(r.count) }));
};

/**
 * Get grouped trace tags from events table
 * Used for filter options
 */
export const getEventsGroupedByTraceTags = async (
  projectId: string,
  filter: FilterState,
  opts?: { extraWhereRaw?: string },
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  // Union+dedup in a single aggregate state instead of UNNEST, which
  // multiplied the scanned spans rows by the tag count before DISTINCT.
  const query = `
    SELECT group_array_union(o.tags) AS tags_union
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
  `;

  const res = await queryDoris<{ tags_union: string[] | string | null }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return parseDorisStringArray(res[0]?.tags_union ?? null)
    .sort()
    .slice(0, 1000)
    .map((tag) => ({ tag }));
};

/**
 * Get grouped prompt names from events table
 * Used for filter options
 */
export const getEventsGroupedByPromptName = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.prompt_name as promptName, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.type = 'GENERATION'
    AND o.prompt_name IS NOT NULL
    AND o.prompt_name != ''
    GROUP BY o.prompt_name
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ promptName: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });

  return res.filter((r) => Boolean(r.promptName));
};

/**
 * Get grouped observation types from events table
 * Used for filter options
 */
export const getEventsGroupedByType = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.type as type, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.type IS NOT NULL
    AND length(o.type) > 0
    GROUP BY o.type
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ type: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ type: r.type, count: Number(r.count) }));
};

/**
 * Get grouped user IDs from events table (joined with traces)
 * Used for filter options
 */
export const getEventsGroupedByUserId = async (
  projectId: string,
  filter: FilterState,
  opts?: { extraWhereRaw?: string },
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.user_id as userId, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.user_id IS NOT NULL
    AND length(o.user_id) > 0
    GROUP BY o.user_id
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ userId: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ userId: r.userId, count: Number(r.count) }));
};

/**
 * Get grouped versions from events table
 * Used for filter options
 */
export const getEventsGroupedByVersion = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.version as version, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.version IS NOT NULL
    AND length(o.version) > 0
    GROUP BY o.version
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ version: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ version: r.version, count: Number(r.count) }));
};

/**
 * Get grouped session IDs from events table (joined with traces)
 * Used for filter options
 */
export const getEventsGroupedBySessionId = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.session_id as sessionId, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.session_id IS NOT NULL
    AND length(o.session_id) > 0
    GROUP BY o.session_id
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ sessionId: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ sessionId: r.sessionId, count: Number(r.count) }));
};

/**
 * Get grouped levels from events table
 * Used for filter options
 */
export const getEventsGroupedByLevel = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.level as level, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.level IS NOT NULL
    AND length(o.level) > 0
    GROUP BY o.level
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ level: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ level: r.level, count: Number(r.count) }));
};

/**
 * Get grouped environments from events table
 * Used for filter options
 */
export const getEventsGroupedByEnvironment = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.environment as environment, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.environment IS NOT NULL
    AND length(o.environment) > 0
    GROUP BY o.environment
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ environment: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({
    environment: r.environment,
    count: Number(r.count),
  }));
};

/**
 * Get grouped experiment dataset IDs from events table
 * Used for filter options
 */
export const getEventsGroupedByExperimentDatasetId = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.experiment_dataset_id as experimentDatasetId, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.experiment_dataset_id IS NOT NULL
    AND length(o.experiment_dataset_id) > 0
    GROUP BY o.experiment_dataset_id
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ experimentDatasetId: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({
    experimentDatasetId: r.experimentDatasetId,
    count: Number(r.count),
  }));
};

/**
 * Get grouped experiment IDs from events table
 * Used for filter options
 */
export const getEventsGroupedByExperimentId = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.experiment_id as experimentId, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.experiment_id IS NOT NULL
    AND length(o.experiment_id) > 0
    GROUP BY o.experiment_id
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ experimentId: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({
    experimentId: r.experimentId,
    count: Number(r.count),
  }));
};

/**
 * Get grouped experiment names from events table
 * Used for filter options
 */
export const getEventsGroupedByExperimentName = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT o.experiment_name as experimentName, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    AND o.experiment_name IS NOT NULL
    AND length(o.experiment_name) > 0
    GROUP BY o.experiment_name
    ORDER BY count(*) DESC
    LIMIT 1000
  `;

  const res = await queryDoris<{ experimentName: string; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({
    experimentName: r.experimentName,
    count: Number(r.count),
  }));
};

/**
 * Get grouped hasParentObservation boolean from events table
 * Used for filter options (counts for "Is Root Observation" facet)
 */
export const getEventsGroupedByHasParentObservation = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      eventsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const query = `
    SELECT (o.is_root = 0) as hasParentObservation, count(*) as count
    FROM ${tableFor(projectId, "spans")} o
    WHERE ${appliedFilter.query}
    GROUP BY (o.is_root = 0)
    ORDER BY hasParentObservation ASC
    LIMIT 2
  `;

  return queryDoris<{ hasParentObservation: boolean; count: number }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
};

/**
 * Get grouped available tool names from events table
 * Used for filter options
 */
export const getEventsGroupedByToolName = async (
  projectId: string,
  filter: FilterState,
) => {
  // Doris does not have tool_definitions column in the same format; return empty
  return [] as { toolName: string; count: number }[];
};

/**
 * Get grouped called tool names from events table
 * Used for filter options
 */
export const getEventsGroupedByCalledToolName = async (
  projectId: string,
  filter: FilterState,
) => {
  // Doris does not have tool_call_names column in the same format; return empty
  return [] as { calledToolName: string; count: number }[];
};

/**
 * Delete events by trace IDs
 * Used when traces are deleted to cascade the deletion to the events table
 */
export const deleteEventsByTraceIds = async (
  projectId: string,
  traceIds: string[],
) => {
  // Preflight query to check if any events exist and get time range
  const preflight = await queryDoris<{
    min_ts: string;
    max_ts: string;
    cnt: string;
  }>({
    query: `
      SELECT
        min(start_time) as min_ts,
        max(start_time) as max_ts,
        count(*) as cnt
      FROM ${tableFor(projectId, "spans")}
      WHERE project_id = {projectId: String} AND trace_id IN ({traceIds: Array(String)})
    `,
    params: { projectId, traceIds },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "delete-preflight",
      projectId,
    },
  });

  const count = Number(preflight[0]?.cnt ?? 0);
  if (count === 0) {
    logger.info(
      `deleteEventsByTraceIds: no rows found for project ${projectId}, skipping DELETE`,
    );
    return;
  }

  // In Doris, we simply delete by trace_ids without time range filtering
  const deleteParams = {
    projectId,
    traceIds,
  };

  await commandDoris({
    query: `
      DELETE FROM ${tableFor(projectId, "spans")}
      WHERE project_id = {projectId: String}
      AND trace_id IN ({traceIds: Array(String)})
    `,
    params: deleteParams,
    tags: {
      feature: "tracing",
      type: "observations",
      kind: "delete",
      projectId,
    },
  });
};

export const hasAnyEvent = async (projectId: string) => {
  const query = `
    SELECT 1
    FROM ${tableFor(projectId, "spans")}
    WHERE project_id = {projectId: String}
    LIMIT 1
  `;

  const rows = await queryDoris<{ 1: number }>({
    query,
    params: { projectId },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "hasAny",
      projectId,
    },
  });

  return rows.length > 0;
};

/**
 * Delete all events for a project
 * Used when an entire project is deleted
 */
export const deleteEventsByProjectId = async (
  projectId: string,
): Promise<boolean> => {
  const hasData = await hasAnyEvent(projectId);
  if (!hasData) {
    return false;
  }

  await commandDoris({
    query: `DELETE FROM ${tableFor(projectId, "spans")} WHERE project_id = {projectId: String}`,
    params: { projectId },
    tags: {
      feature: "tracing",
      type: "observations",
      kind: "delete",
      projectId,
    },
  });

  return true;
};

export async function getAgentGraphDataFromEventsTable(params: {
  projectId: string;
  traceId: string;
  chMinStartTime: string;
  chMaxStartTime: string;
}) {
  const { projectId, traceId, chMinStartTime, chMaxStartTime } = params;

  // metadata is read via to_json(metadata) — raw MAP text does not escape inner quotes.
  const query = `
    SELECT
      e.span_id AS id,
      e.parent_span_id AS parent_observation_id,
      e.type,
      e.name,
      e.start_time,
      e.end_time,
      e.metadata['langgraph_node'] AS node,
      e.metadata['langgraph_step'] AS step
    FROM ${tableFor(projectId, "spans")} e
    WHERE
      e.project_id = {projectId: String}
      AND e.trace_id = {traceId: String}
      AND e.start_time >= {chMinStartTime: String}
      AND e.start_time <= {chMaxStartTime: String}
  `;

  return queryDoris({
    query,
    params: { projectId, traceId, chMinStartTime, chMaxStartTime },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "agentGraphData",
      projectId,
    },
  });
}

export const hasAnyEventOlderThan = async (
  projectId: string,
  beforeDate: Date,
) => {
  const query = `
    SELECT 1
    FROM ${tableFor(projectId, "spans")}
    WHERE project_id = {projectId: String}
    AND start_time < {cutoffDate: String}
    LIMIT 1
  `;

  const rows = await queryDoris<{ 1: number }>({
    query,
    params: {
      projectId,
      cutoffDate: convertDateToAnalyticsDateTime(beforeDate),
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "hasAnyOlderThan",
      projectId,
    },
  });

  return rows.length > 0;
};

/**
 * Delete events older than a cutoff date
 * Used for data retention cleanup
 */
export const deleteEventsOlderThanDays = async (
  projectId: string,
  beforeDate: Date,
): Promise<boolean> => {
  const hasData = await hasAnyEventOlderThan(projectId, beforeDate);
  if (!hasData) {
    return false;
  }

  const deleteQuery = `
    DELETE FROM ${tableFor(projectId, "spans")}
    WHERE project_id = {projectId: String}
    AND start_time < {cutoffDate: String}
  `;
  const deleteParams = {
    projectId,
    cutoffDate: convertDateToAnalyticsDateTime(beforeDate),
  };

  await commandDoris({
    query: deleteQuery,
    params: deleteParams,
    tags: {
      feature: "tracing",
      type: "observations",
      kind: "delete",
      projectId,
    },
  });

  return true;
};

/**
 * Doris hands back JSON-typed columns as objects and string-typed ones as
 * strings. These two keep the batch-IO mapping explicit instead of sprinkling
 * `as any` over the opt-in columns.
 */
const parseJsonColumn = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Extra, opt-in columns of the batch-IO row. Upstream's `experimentBatchIO` /
 * `batchIO` ask for these (`includeExperimentFields` / `includeToolCallFields`);
 * the keys are camelCase because the consumers are the eval variable-mapping UI
 * (`zipToolCallsFromRecord` reads `toolCalls` / `toolCallNames`, and
 * `CODE_EVAL_TEMPLATE_VARIABLES` names `toolCalls`, `experimentItemExpectedOutput`,
 * `experimentItemMetadata`).
 */
export type EventBatchIOExtraFields = {
  toolDefinitions?: unknown;
  toolCalls?: unknown;
  toolCallNames?: unknown;
  experimentId?: string | null;
  experimentName?: string | null;
  experimentDescription?: string | null;
  experimentDatasetId?: string | null;
  experimentMetadata?: unknown;
  experimentItemId?: string | null;
  experimentItemVersion?: string | null;
  experimentItemRootSpanId?: string | null;
  experimentItemExpectedOutput?: unknown;
  experimentItemMetadata?: unknown;
};

export const getObservationsBatchIOFromEventsTable = async (opts: {
  projectId: string;
  observations: Array<{
    id: string;
    traceId: string;
  }>;
  minStartTime: Date;
  maxStartTime: Date;
  truncated?: boolean; // Default true for performance, false for full data
  /**
   * Overrides the server-side character limit used when `truncated`. Absent keeps
   * `LITEFUSE_SERVER_SIDE_IO_CHAR_LIMIT`, i.e. the SQL is unchanged.
   */
  ioCharLimit?: number;
  /** Adds the tool-call columns to each row (upstream `includeToolCallFields`). */
  includeToolCallFields?: boolean;
  /** Adds the experiment columns to each row (upstream `includeExperimentFields`). */
  includeExperimentFields?: boolean;
}): Promise<
  Array<
    Pick<Observation, "id" | "input" | "output" | "metadata"> &
      EventBatchIOExtraFields
  >
> => {
  if (opts.observations.length === 0) {
    return [];
  }

  const truncated = opts.truncated ?? true;

  // Extract IDs and trace IDs for filtering
  const observationIds = opts.observations.map((o) => o.id);
  const traceIds = [...new Set(opts.observations.map((o) => o.traceId))];

  // Use provided timestamp range with buffer for efficient filtering
  const minTimestamp = new Date(opts.minStartTime.getTime() - 1000); // -1 second buffer
  const maxTimestamp = new Date(opts.maxStartTime.getTime() + 1000); // +1 second buffer

  // In Doris, we use the observations table for both truncated and full I/O
  // Use SUBSTRING instead of leftUTF8 for truncation
  const ioCharLimit = opts.ioCharLimit ?? env.LITEFUSE_SERVER_SIDE_IO_CHAR_LIMIT;
  const inputSelect = truncated
    ? `SUBSTRING(e.input, 1, ${ioCharLimit}) as input`
    : `e.input as input`;
  const outputSelect = truncated
    ? `SUBSTRING(e.output, 1, ${ioCharLimit}) as output`
    : `e.output as output`;

  // Opt-in columns. Kept out of the SELECT unless asked for, so the existing
  // callers' query text is unchanged.
  const extraSelects = [
    ...(opts.includeToolCallFields
      ? [
          `e.tool_definitions as tool_definitions`,
          `e.tool_calls as tool_calls`,
          `e.tool_call_names as tool_call_names`,
        ]
      : []),
    ...(opts.includeExperimentFields
      ? [
          `e.experiment_id as experiment_id`,
          `e.experiment_name as experiment_name`,
          `e.experiment_description as experiment_description`,
          `e.experiment_dataset_id as experiment_dataset_id`,
          `e.experiment_metadata as experiment_metadata`,
          `e.experiment_item_id as experiment_item_id`,
          `e.experiment_item_version as experiment_item_version`,
          `e.experiment_item_root_span_id as experiment_item_root_span_id`,
          `e.experiment_item_expected_output as experiment_item_expected_output`,
          `e.experiment_item_metadata as experiment_item_metadata`,
        ]
      : []),
  ];

  const query = `
    SELECT
      e.span_id AS id,
      ${inputSelect},
      ${outputSelect},
      json_object_flatten(e.metadata) AS metadata
      ${extraSelects.length ? `, ${extraSelects.join(", ")}` : ""}
    FROM ${tableFor(opts.projectId, "spans")} e
    WHERE e.project_id = {projectId: String}
      AND e.span_id IN ({observationIds: Array(String)})
      AND e.trace_id IN ({traceIds: Array(String)})
      AND e.start_time >= {minTimestamp: String}
      AND e.start_time <= {maxTimestamp: String}
  `;

  const results = await queryDoris<{
    id: string;
    input: string | null;
    output: string | null;
    metadata: unknown;
  } & Record<string, unknown>>({
    query,
    params: {
      projectId: opts.projectId,
      observationIds,
      traceIds,
      minTimestamp: convertDateToAnalyticsDateTime(minTimestamp),
      maxTimestamp: convertDateToAnalyticsDateTime(maxTimestamp),
    },
    tags: {
      feature: "tracing",
      type: "events",
      kind: "batchIO",
      projectId: opts.projectId,
    },
  });

  return results.map((r) => ({
    id: r.id,
    input:
      r.input !== undefined
        ? applyInputOutputRendering(r.input, DEFAULT_RENDERING_PROPS)
        : null,
    output:
      r.output !== undefined
        ? applyInputOutputRendering(r.output, DEFAULT_RENDERING_PROPS)
        : null,
    metadata: parseMetadataCHRecordToDomain(
      typeof r.metadata === "string"
        ? JSON.parse(r.metadata)
        : (r.metadata ?? {}),
    ),
    // Only the requested run of columns; keys are camelCase for the consumers.
    ...(opts.includeToolCallFields
      ? {
          toolDefinitions: parseJsonColumn(r.tool_definitions),
          toolCalls: Array.isArray(r.tool_calls) ? r.tool_calls : [],
          toolCallNames: Array.isArray(r.tool_call_names)
            ? r.tool_call_names
            : [],
        }
      : {}),
    ...(opts.includeExperimentFields
      ? {
          experimentId: asNullableString(r.experiment_id),
          experimentName: asNullableString(r.experiment_name),
          experimentDescription: asNullableString(r.experiment_description),
          experimentDatasetId: asNullableString(r.experiment_dataset_id),
          experimentMetadata: parseJsonColumn(r.experiment_metadata),
          experimentItemId: asNullableString(r.experiment_item_id),
          experimentItemVersion: asNullableString(r.experiment_item_version),
          experimentItemRootSpanId: asNullableString(
            r.experiment_item_root_span_id,
          ),
          experimentItemExpectedOutput: parseJsonColumn(
            r.experiment_item_expected_output,
          ),
          experimentItemMetadata: parseJsonColumn(r.experiment_item_metadata),
        }
      : {}),
  }));
};

/**
 * Column mappings for user queries from events table.
 * Includes a "Timestamp" mapping that points to start_time for compatibility
 * with the Users page filter state (which uses "Timestamp" from traces table).
 */
const usersFromEventsTableColumnDefinitionsForDoris: UiColumnMappings = [
  ...eventsTableUiColumnDefinitionsForDoris,
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "observations",
    select: "o.start_time",
  },
];

// traces_scalar (one row per trace — migration 0039) exposed under the
// `o`-prefixed column names the Users-page filter mappings reference
// (o.start_time via the "Timestamp" compat mapping, o.user_id, o.trace_name,
// o.environment, …). The per-user queries below are trace-grained — user_id
// is a root-span scalar — so they read this table instead of scanning
// spans. traces_scalar stores NULL where spans root rows store ''
// (name/user_id/session_id/release/version) — COALESCE back to '' so negative
// filter operators keep matching unset rows (raw NULL predicates silently
// drop them); "has a user" is therefore `user_id != ''`, matching the old
// spans guard.
const tracesScalarAsOForUsers = (projectId: string) => `(
      SELECT
        project_id,
        id AS trace_id,
        COALESCE(name, '') AS name,
        COALESCE(name, '') AS trace_name,
        COALESCE(user_id, '') AS user_id,
        COALESCE(session_id, '') AS session_id,
        environment,
        tags,
        metadata,
        start_time,
        COALESCE(${dq("release")}, '') AS ${dq("release")},
        COALESCE(version, '') AS version,
        created_at
      FROM ${tableFor(projectId, "traces_scalar")}
    ) o`;

/**
 * Get users with trace counts from events table with pagination
 * Similar to getTracesGroupedByUsers but queries the events table
 */
export const getUsersFromEventsTable = async (
  projectId: string,
  filter: FilterState,
  searchQuery?: string,
  limit?: number,
  offset?: number,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "o",
  });

  // usersFromEventsTable… (not the plain events defs): includes the
  // "Timestamp" → o.start_time compat mapping the Users-page filter state
  // sends, matching what the count/metrics siblings already accepted.
  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      usersFromEventsTableColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const searchCondition = searchQuery
    ? `AND o.user_id LIKE {searchQuery: String}`
    : "";

  const query = `
    SELECT o.user_id as user, count(DISTINCT o.trace_id) as count
    FROM ${tracesScalarAsOForUsers(projectId)}
    WHERE ${appliedFilter.query}
    AND o.user_id != ''
    ${searchCondition}
    GROUP BY o.user_id
    -- user ASC tiebreaker: equal counts otherwise page nondeterministically
    -- (a user can repeat on or vanish between pages as plans change).
    ORDER BY count DESC, user ASC
    LIMIT {limit: Int32}
    OFFSET {offset: Int32}
  `;

  return queryDoris<{ user: string; count: string }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
      limit: limit ?? 100,
      offset: offset ?? 0,
      ...(searchQuery ? { searchQuery: `%${searchQuery}%` } : {}),
    },
    tags: {
      feature: "users",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
};

/**
 * Get total user count from events table
 */
export const getUsersCountFromEventsTable = async (
  projectId: string,
  filter: FilterState,
  searchQuery?: string,
): Promise<{ totalCount: string }[]> => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "o",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      usersFromEventsTableColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  const searchCondition = searchQuery
    ? `AND o.user_id LIKE {searchQuery: String}`
    : "";

  const query = `
    SELECT count(DISTINCT o.user_id) AS totalCount
    FROM ${tracesScalarAsOForUsers(projectId)}
    WHERE ${appliedFilter.query}
    AND o.user_id != ''
    ${searchCondition}
  `;

  return queryDoris<{ totalCount: string }>({
    query,
    params: {
      projectId,
      ...appliedFilter.params,
      ...(searchQuery ? { searchQuery: `%${searchQuery}%` } : {}),
    },
    tags: {
      feature: "users",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });
};

/**
 * Get user metrics from events table.
 * Same query shape as getUserMetrics in traces.ts: per-trace metrics from the
 * trace_metrics_agg rewrite shape over spans, joined/aggregated up to
 * per-user via traces_scalar (which carries the root's user_id and the trace
 * time window — min/max here are trace timestamps).
 */
export const getUserMetricsFromEventsTable = async (
  projectId: string,
  userIds: string[],
  filter: FilterState,
) => {
  if (userIds.length === 0) {
    return [];
  }

  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "o",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      usersFromEventsTableColumnDefinitionsForDoris,
    ),
  );

  const appliedFilter = observationsFilter.apply();

  // Partition-prune the metrics CTE off the Users-page timestamp filter
  // ("Timestamp" → o.start_time). Day-truncated bound, loosened by
  // OBSERVATIONS_TO_TRACE_INTERVAL, so it stays answerable by the rollup's
  // day key and never cuts spans of a trace the scalar-side filter selects.
  const timestampFilter = observationsFilter.find(
    (f) =>
      f.field === "o.start_time" && (f.operator === ">=" || f.operator === ">"),
  ) as DorisDateTimeFilter | undefined;

  // Per-trace metrics via the trace_metrics_agg rewrite shape (sync MV,
  // migration 0040): the CTE aggregates spans with EXACTLY the MV's
  // expression shapes, grouped by project_id, trace_id, so Doris rewrites the
  // scan onto the rollup. It must contain ONLY that scan (a JOIN inside the
  // same SELECT breaks the rewrite); user_id and the trace scalars join in
  // from traces_scalar. Usage comes from the ingestion-precomputed
  // *_calculated reductions of usage_details; obs_count keeps the old
  // "all spans including root" semantics (observation_count is non-root,
  // COUNT(*) adds one root per joined trace back). Unlike the previous
  // spans GROUP BY, this no longer relies on user_id being denormalized
  // onto every span — with OTel ingestion only root rows carry it, which made
  // the old per-user sums miss all child-span usage/cost.
  const query = `
    WITH per_trace_metrics as (
      SELECT
          project_id,
          trace_id,
          SUM(total_cost) as sum_total_cost,
          SUM(input_tokens_calculated) as input_usage,
          SUM(output_tokens_calculated) as output_usage,
          SUM(total_tokens_calculated) as total_usage,
          SUM(CASE WHEN is_root = 0 THEN 1 ELSE 0 END) as observation_count
      FROM ${tableFor(projectId, "spans")}
      WHERE project_id = {projectId: String}
      ${timestampFilter ? `AND date_trunc(start_time, 'day') >= date_trunc(DATE_SUB({metricsFromTs: DateTime}, ${OBSERVATIONS_TO_TRACE_INTERVAL}), 'day')` : ""}
      GROUP BY project_id, trace_id
    )
    SELECT
      o.user_id as user_id,
      MAX(o.environment) as environment,
      COALESCE(SUM(m.observation_count), 0) + COUNT(*) as obs_count,
      count(DISTINCT o.trace_id) as trace_count,
      COALESCE(SUM(m.input_usage), 0) as input_usage,
      COALESCE(SUM(m.output_usage), 0) as output_usage,
      COALESCE(SUM(m.total_usage), 0) as total_usage,
      COALESCE(SUM(m.sum_total_cost), 0) as sum_total_cost,
      min(o.start_time) as min_timestamp,
      max(o.start_time) as max_timestamp
    FROM ${tracesScalarAsOForUsers(projectId)}
    JOIN per_trace_metrics m
      ON m.project_id = o.project_id
      AND m.trace_id = o.trace_id
    WHERE ${appliedFilter.query}
    AND o.user_id IN ({userIds: Array(String)})
    AND o.user_id != ''
    GROUP BY o.user_id
  `;

  const rows = await queryDoris<{
    user_id: string;
    environment: string;
    max_timestamp: string;
    min_timestamp: string;
    input_usage: string;
    output_usage: string;
    total_usage: string;
    obs_count: string;
    trace_count: string;
    sum_total_cost: string;
  }>({
    query,
    params: {
      projectId,
      userIds,
      ...appliedFilter.params,
      ...(timestampFilter
        ? {
            metricsFromTs: convertDateToAnalyticsDateTime(
              timestampFilter.value,
            ),
          }
        : {}),
    },
    tags: {
      feature: "users",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });

  return rows.map((row) => ({
    userId: row.user_id,
    environment: row.environment,
    maxTimestamp: parseDorisUTCDateTimeFormat(row.max_timestamp),
    minTimestamp: parseDorisUTCDateTimeFormat(row.min_timestamp),
    inputUsage: Number(row.input_usage),
    outputUsage: Number(row.output_usage),
    totalUsage: Number(row.total_usage),
    observationCount: Number(row.obs_count),
    traceCount: Number(row.trace_count),
    totalCost: Number(row.sum_total_cost),
  }));
};

/**
 * Check if any user exists in events table
 * Uses hasAnyEvent pattern but filters for user_id
 */
export const hasAnyUserFromEventsTable = async (
  projectId: string,
): Promise<boolean> => {
  // traces_scalar: one row per trace with the root's user_id (NULL where the
  // root row stored '') — a flat indexed probe instead of an spans scan.
  const query = `
    SELECT 1
    FROM ${tableFor(projectId, "traces_scalar")}
    WHERE project_id = {projectId: String}
    AND user_id IS NOT NULL
    LIMIT 1
  `;

  const rows = await queryDoris<{ 1: number }>({
    query,
    params: { projectId },
    tags: {
      feature: "users",
      type: "events",
      kind: "hasAny",
      projectId,
    },
  });

  return rows.length > 0;
};

/**
 * Streams events from Doris for blob storage export.
 */
export const getEventsForBlobStorageExport = function (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
) {
  // Build the query for blob storage export using spans table
  const query = `
    SELECT
      o.span_id AS id,
      o.trace_id,
      o.name,
      o.type,
      o.level,
      o.version,
      o.environment,
      o.user_id,
      o.session_id,
      o.tags,
      o.${dq("release")},
      o.trace_name,
      o.total_cost,
      if(o.end_time is null, null, milliseconds_diff(o.end_time, o.start_time)) as latency,
      o.input,
      o.output,
      json_object_flatten(o.metadata) AS metadata,
      o.start_time,
      o.end_time,
      o.provided_model_name as model,
      o.prompt_name,
      o.prompt_version,
      o.status_message,
      o.parent_span_id AS parent_observation_id,
      o.version as event_version
    FROM ${tableFor(projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
    AND o.start_time >= {minTimestamp: String}
    AND o.start_time <= {maxTimestamp: String}
    ORDER BY o.start_time
  `;

  return queryDorisStream<Record<string, unknown>>({
    query,
    params: {
      projectId,
      minTimestamp: convertDateToAnalyticsDateTime(minTimestamp),
      maxTimestamp: convertDateToAnalyticsDateTime(maxTimestamp),
    },
    tags: {
      feature: "blobstorage",
      type: "event",
      kind: "analytic",
      projectId,
    },
  });
};

/**
 * Streams events from Doris for analytics integrations (PostHog, Mixpanel).
 * All fields come directly from the observations table.
 */
export const getEventsForAnalyticsIntegrations = async function* (
  projectId: string,
  projectName: string,
  minTimestamp: Date,
  maxTimestamp: Date,
) {
  // In spans, metadata is stored as parallel arrays and usage/cost details are maps
  const query = `
    SELECT
      o.span_id AS id,
      o.trace_id,
      o.name,
      o.type,
      o.level,
      o.version,
      o.environment,
      o.user_id,
      o.session_id,
      o.tags,
      o.${dq("release")},
      o.trace_name,
      o.total_cost,
      if(o.end_time is null, null, milliseconds_diff(o.end_time, o.start_time)) as latency,
      o.start_time,
      o.end_time,
      o.provided_model_name as model,
      o.prompt_name,
      o.prompt_version,
      json_object_flatten(o.metadata) AS metadata,
      o.usage_details,
      o.cost_details,
      o.provided_model_name,
      if(o.completion_start_time is null, null, milliseconds_diff(o.completion_start_time, o.start_time)) as time_to_first_token
    FROM ${tableFor(projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
    AND o.start_time >= {minTimestamp: String}
    AND o.start_time <= {maxTimestamp: String}
  `;

  const records = queryDorisStream<DorisAnalyticsObservationRecord>({
    query,
    params: {
      projectId,
      minTimestamp: convertDateToAnalyticsDateTime(minTimestamp),
      maxTimestamp: convertDateToAnalyticsDateTime(maxTimestamp),
    },
    tags: {
      feature: "analytics-integration",
      type: "event",
      kind: "analytic",
      projectId,
    },
  });

  const baseUrl = env.NEXTAUTH_URL?.replace("/api/auth", "");
  for await (const record of records) {
    const metadata =
      typeof record.metadata === "string"
        ? JSON.parse(record.metadata)
        : (record.metadata ?? {});
    yield {
      timestamp: record.start_time,
      langfuse_observation_name: record.name,
      langfuse_trace_name: record.trace_name,
      langfuse_trace_id: record.trace_id,
      langfuse_url: `${baseUrl}/project/${projectId}/traces/${encodeURIComponent(record.trace_id as string)}?observation=${encodeURIComponent(record.id as string)}`,
      langfuse_user_url: record.user_id
        ? `${baseUrl}/project/${projectId}/users/${encodeURIComponent(record.user_id as string)}`
        : undefined,
      langfuse_id: record.id,
      langfuse_cost_usd: record.total_cost,
      langfuse_input_units: record.usage_details?.input ?? null,
      langfuse_output_units: record.usage_details?.output ?? null,
      langfuse_total_units: record.usage_details?.total ?? null,
      langfuse_session_id: record.session_id,
      langfuse_project_id: projectId,
      langfuse_project_name: projectName,
      langfuse_user_id: record.user_id || null,
      langfuse_latency: record.latency,
      langfuse_time_to_first_token: record.time_to_first_token,
      langfuse_release: record.release,
      langfuse_version: record.version,
      langfuse_model: record.provided_model_name,
      langfuse_level: record.level,
      langfuse_type: record.type,
      langfuse_tags: record.tags,
      langfuse_environment: record.environment,
      langfuse_event_version: "1.0.0",
      posthog_session_id: metadata?.posthog_session_id ?? null,
      mixpanel_session_id: metadata?.mixpanel_session_id ?? null,
    } satisfies AnalyticsObservationEvent;
  }
};

/*
 * Check if any session exists in events table
 * Filters for non-empty session_id
 */
export const hasAnySessionFromEventsTable = async (
  projectId: string,
): Promise<boolean> => {
  // traces_scalar: one row per trace with the root's session_id (NULL where
  // the root row stored '', so IS NOT NULL replaces the old length() guard) —
  // a flat indexed probe instead of an spans scan.
  const query = `
    SELECT 1
    FROM ${tableFor(projectId, "traces_scalar")}
    WHERE project_id = {projectId: String}
    AND session_id IS NOT NULL
    LIMIT 1
  `;

  const rows = await queryDoris<{ 1: number }>({
    query,
    params: { projectId },
    tags: {
      feature: "sessions",
      type: "events",
      kind: "hasAny",
      projectId,
    },
  });

  return rows.length > 0;
};

/**
 * Fetch trace metadata (name, user_id, tags) for a list of trace IDs.
 * Used by the scores table to enrich score rows with trace-level data.
 */
export const getTraceMetadataByIdsFromEvents = async (props: {
  projectId: string;
  traceIds: string[];
}) => {
  if (props.traceIds.length === 0) return [];

  // Pure trace-scalar batch read → traces_scalar (one row per trace, id is
  // the distribution column — migration 0039). COALESCE keeps the previous
  // spans ''-for-unset convention (traces_scalar stores NULL there).
  const query = `
    SELECT
      t.id,
      COALESCE(t.name, '') AS name,
      COALESCE(t.user_id, '') AS user_id,
      t.tags
    FROM ${tableFor(props.projectId, "traces_scalar")} t
    WHERE t.project_id = {projectId: String}
    AND t.id IN ({traceIds: Array(String)})
  `;

  return queryDoris<{
    id: string;
    name: string;
    user_id: string;
    tags: string[];
  }>({
    query,
    params: {
      projectId: props.projectId,
      traceIds: props.traceIds,
    },
    tags: {
      feature: "tracing",
      type: "trace-metadata",
      projectId: props.projectId,
    },
  });
};

export const getAvgCostByEvaluatorIds = async (
  projectId: string,
  evaluatorIds: string[],
): Promise<
  Array<{ evaluatorId: string; avgCost: number; executionCount: number }>
> => {
  if (evaluatorIds.length === 0) return [];

  // metadata is a Doris VARIANT column: a bare subfield read (metadata['key'])
  // yields a VARIANT-typed expression, which Doris rejects in filter/group
  // by/order by. Wrap the subfield in CAST(... AS STRING) — the accepted idiom
  // (see traces-ui-table-service) — which returns the bare unquoted scalar so
  // IN-matching and GROUP BY work.
  const query = `
    SELECT
      CAST(o.metadata['job_configuration_id'] AS STRING) as evaluator_id,
      avg(o.total_cost) as avg_cost,
      count(*) as execution_count
    FROM ${tableFor(projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
    AND o.type = 'GENERATION'
    AND CAST(o.metadata['job_configuration_id'] AS STRING) IS NOT NULL
    AND CAST(o.metadata['job_configuration_id'] AS STRING) IN ({evaluatorIds: Array(String)})
    AND o.start_time >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)
    GROUP BY CAST(o.metadata['job_configuration_id'] AS STRING)
  `;

  const rows = await queryDoris<{
    evaluator_id: string;
    avg_cost: string;
    execution_count: string;
  }>({
    query,
    params: {
      projectId,
      evaluatorIds,
    },
    tags: {
      feature: "evals",
      type: "events",
      kind: "analytic",
      projectId,
    },
  });

  return rows.map((row) => ({
    evaluatorId: row.evaluator_id,
    avgCost: Number(row.avg_cost),
    executionCount: Number(row.execution_count),
  }));
};

// Doris-compatible type for session-level metrics queries
type DorisSessionEventsMetricsRow = {
  session_id: string;
  max_timestamp: string;
  min_timestamp: string;
  trace_ids: string[];
  user_ids: string[];
  trace_count: number;
  trace_tags: string[];
  environment?: string;
  total_observations: number;
  duration: number;
  session_usage_details: Record<string, number>;
  session_cost_details: Record<string, number>;
  session_input_cost: string;
  session_output_cost: string;
  session_total_cost: string;
  session_input_usage: string;
  session_output_usage: string;
  session_total_usage: string;
};

// Doris-compatible type for analytics integration observations
type DorisAnalyticsObservationRecord = {
  id: string;
  trace_id: string;
  name: string;
  type: string;
  level: string;
  version: string;
  environment: string;
  user_id: string | null;
  session_id: string | null;
  tags: string[];
  release: string;
  trace_name: string;
  total_cost: number | null;
  latency: number | null;
  start_time: string;
  end_time: string | null;
  model: string | null;
  prompt_name: string | null;
  prompt_version: number | null;
  metadata: unknown;
  usage_details: Record<string, number>;
  cost_details: Record<string, number>;
  provided_model_name: string | null;
  time_to_first_token: number | null;
};

export const getSessionMetricsFromEvents = async (props: {
  projectId: string;
  sessionIds: string[];
  queryFromTimestamp?: Date;
}) => {
  if (props.sessionIds.length === 0) return [];

  // Build time filter if provided
  const timeCondition = props.queryFromTimestamp
    ? `AND o.start_time >= {queryFromTimestamp: String}`
    : "";

  const query = `
    SELECT
      o.session_id,
      max(o.start_time) as max_timestamp,
      min(o.start_time) as min_timestamp,
      array_distinct(collect_list(o.trace_id)) as trace_ids,
      array_distinct(collect_list(o.user_id)) as user_ids,
      count(DISTINCT o.trace_id) as trace_count,
      array_distinct(array_flatten(collect_list(o.tags))) as trace_tags,
      any(o.environment) as environment,
      count(*) as total_observations,
      max(o.start_time) - min(o.start_time) as duration,
      sum(if(MAP_CONTAINS_KEY(o.usage_details,'input'), o.usage_details['input'], 0)) as session_input_usage,
      sum(if(MAP_CONTAINS_KEY(o.usage_details,'output'), o.usage_details['output'], 0)) as session_output_usage,
      sum(if(MAP_CONTAINS_KEY(o.usage_details,'total'), o.usage_details['total'], 0)) as session_total_usage,
      sum(if(MAP_CONTAINS_KEY(o.cost_details,'input'), o.cost_details['input'], 0)) as session_input_cost,
      sum(if(MAP_CONTAINS_KEY(o.cost_details,'output'), o.cost_details['output'], 0)) as session_output_cost,
      sum(if(MAP_CONTAINS_KEY(o.cost_details,'total'), o.cost_details['total'], 0)) as session_total_cost
    FROM ${tableFor(props.projectId, "spans")} o
    WHERE o.project_id = {projectId: String}
    AND o.session_id IN ({sessionIds: Array(String)})
    AND o.session_id IS NOT NULL
    AND length(o.session_id) > 0
    ${timeCondition}
    GROUP BY o.session_id
  `;

  const rows = await queryDoris<DorisSessionEventsMetricsRow>({
    query,
    params: {
      projectId: props.projectId,
      sessionIds: props.sessionIds,
      ...(props.queryFromTimestamp
        ? {
            queryFromTimestamp: convertDateToAnalyticsDateTime(
              props.queryFromTimestamp,
            ),
          }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "session-metrics-direct",
      projectId: props.projectId,
    },
  });

  return rows.map((row) => ({
    ...row,
    trace_count: Number(row.trace_count),
    total_observations: Number(row.total_observations),
  }));
};
