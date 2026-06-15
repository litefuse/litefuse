import {
  queryDoris,
  commandDoris,
  queryDorisStream,
  parseDorisUTCDateTimeFormat,
} from "./doris";
import { convertDateToAnalyticsDateTime, dq } from "./analytics";
import {
  createDorisFilterFromFilterState,
  getDorisProjectIdDefaultFilter,
} from "../queries/doris-sql/factory";
import { orderByToDorisSQL } from "../queries/doris-sql/orderby-factory";
import {
  dorisSearchCondition,
  DorisSearchContext,
} from "../queries/doris-sql/search";
import { logger } from "../logger";
import { InternalServerError, LangfuseNotFoundError } from "../../errors";
import { prisma } from "../../db";
import { ObservationRecordReadType } from "./definitions";
import { FilterState } from "../../types";
import { FullObservations } from "../queries";
import {
  observationsTableTraceUiColumnDefinitionsForDoris,
  observationsTableUiColumnDefinitionsForDoris,
} from "../tableMappings";
import { OrderByState } from "../../interfaces/orderBy";
import { getTracesByIds } from "./traces";
import { zipDorisMetadataArrays } from "../utils/dorisArrays";
import {
  convertObservation,
  enrichObservationWithModelData,
} from "./observations_converters";
import {
  OBSERVATIONS_TO_TRACE_INTERVAL,
  TRACE_TO_OBSERVATIONS_INTERVAL,
} from "./constants";
import { env } from "../../env";
import { TracingSearchType } from "../../interfaces/search";
import { observationsTableCols } from "../../observationsTable";
import type { AnalyticsGenerationEvent } from "../analytics-integrations/types";
import { ObservationType } from "../../domain";
import { recordDistribution } from "../instrumentation";
import { DEFAULT_RENDERING_PROPS, RenderingProps } from "../utils/rendering";

/**
 * Checks if observation exists in Doris.
 *
 * @param {string} projectId - Project ID for the observation
 * @param {string} id - ID of the observation
 * @param {Date} startTime - Timestamp for time-based filtering, uses event payload or job timestamp
 * @returns {Promise<boolean>} - True if observation exists
 *
 * Notes:
 * • Filters with two days lookback window subject to startTime
 * • Used for validating observation references before eval job creation
 */
export const checkObservationExists = async (
  projectId: string,
  id: string,
  startTime: Date | undefined,
): Promise<boolean> => {
  const query = `
    SELECT span_id AS id, project_id
    FROM events_full o
    WHERE project_id = {projectId: String}
    AND span_id = {id: String}
    ${startTime ? `AND start_time >= DATE_SUB({startTime: DateTime}, INTERVAL 2 DAY)` : ""}
    LIMIT 1
  `;

  const rows = await queryDoris<{ id: string; project_id: string }>({
    query,
    params: {
      id,
      projectId,
      ...(startTime
        ? { startTime: convertDateToAnalyticsDateTime(startTime) }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "exists",
      projectId,
    },
  });

  return rows.length > 0;
};

// Helper function to preprocess Doris usage/cost details
const preprocessDorisUsageCostDetails = (record: any): any => {
  const processed = { ...record };

  const usageCostFields = [
    "provided_usage_details",
    "usage_details",
    "provided_cost_details",
    "cost_details",
  ];

  for (const field of usageCostFields) {
    if (processed[field] && typeof processed[field] === "string") {
      try {
        const parsed = JSON.parse(processed[field]);
        if (typeof parsed === "object" && !Array.isArray(parsed)) {
          // Convert to format expected by UsageCostSchema
          const result: Record<string, string | null> = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (value === null || value === undefined) {
              result[key] = null;
            } else {
              // Convert to string, but ensure it's a valid number string
              const numValue = Number(value);
              result[key] = isNaN(numValue) ? null : String(numValue);
            }
          }
          processed[field] = result;
        } else {
          processed[field] = {};
        }
      } catch {
        processed[field] = {};
      }
    } else if (!processed[field]) {
      processed[field] = {};
    }
  }

  return processed;
};

export type GetObservationsForTraceOpts<IncludeIO extends boolean> = {
  traceId: string;
  projectId: string;
  timestamp?: Date;
  includeIO?: IncludeIO;
};

export const getObservationsForTrace = async <IncludeIO extends boolean>(
  opts: GetObservationsForTraceOpts<IncludeIO>,
) => {
  const { traceId, projectId, timestamp, includeIO = false } = opts;

  let records: ObservationRecordReadType[];

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
      ${includeIO === true ? "input, output, metadata_names, metadata_values," : ""}
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
      usage_pricing_tier_id,
      usage_pricing_tier_name,
      tool_definitions,
      tool_calls,
      tool_call_names,
      created_at,
      updated_at,
      event_ts
    FROM events_full
    WHERE trace_id = {traceId: String}
    AND project_id = {projectId: String}
    ${timestamp ? `AND start_time >= DATE_SUB({traceTimestamp: DateTime}, ${TRACE_TO_OBSERVATIONS_INTERVAL})` : ""}
    ORDER BY start_time ASC
  `;
  const rawRecords = await queryDoris<any>({
    query,
    params: {
      traceId,
      projectId,
      ...(timestamp
        ? { traceTimestamp: convertDateToAnalyticsDateTime(timestamp) }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "list",
      projectId,
    },
  });

  // Normalize Doris-returned string-encoded usage/cost details into the
  // object shape the downstream converter expects, and zip
  // metadata_names + metadata_values into the metadata Record.
  records = rawRecords.map((r) => {
    const preprocessed = preprocessDorisUsageCostDetails(r);
    return {
      ...preprocessed,
      metadata:
        includeIO === true
          ? zipDorisMetadataArrays(r.metadata_names, r.metadata_values)
          : {},
    };
  }) as ObservationRecordReadType[];

  // Large number of observations in trace with large input / output / metadata will lead to
  // high CPU and memory consumption in the convertObservation step, where parsing occurs
  // Thus, limit the size of the payload to 5MB, follows NextJS response size limitation:
  // https://nextjs.org/docs/messages/api-routes-response-size-limit
  // See also LFE-4882 for more details
  let payloadSize = 0;

  for (const observation of records) {
    for (const key of ["input", "output"] as const) {
      const value = observation[key];

      if (value && typeof value === "string") {
        payloadSize += value.length;
      }
    }

    const metadataValues = Object.values(observation["metadata"] ?? {});

    metadataValues.forEach((value) => {
      if (value && typeof value === "string") {
        payloadSize += value.length;
      }
    });

    if (payloadSize >= env.LITEFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES) {
      const errorMessage = `Observations in trace are too large: ${(payloadSize / 1e6).toFixed(2)}MB exceeds limit of ${(env.LITEFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES / 1e6).toFixed(2)}MB`;

      throw new Error(errorMessage);
    }
  }

  return records.map((r) => {
    const observation = convertObservation({
      ...r,
      metadata: r.metadata ?? {},
    });
    recordDistribution(
      "langfuse.query_by_id_age",
      new Date().getTime() - observation.startTime.getTime(),
      {
        table: "observations",
      },
    );
    return observation;
  });
};

export const getObservationForTraceIdByName = async ({
  traceId,
  projectId,
  name,
  timestamp,
  fetchWithInputOutput = false,
}: {
  traceId: string;
  projectId: string;
  name: string;
  timestamp?: Date;
  fetchWithInputOutput?: boolean;
}) => {
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
      metadata_names,
      metadata_values,
      level,
      status_message,
      version,
      ${fetchWithInputOutput ? "input, output," : ""}
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
      usage_pricing_tier_id,
      usage_pricing_tier_name,
      tool_definitions,
      tool_calls,
      tool_call_names,
      created_at,
      updated_at,
      event_ts
    FROM events_full
    WHERE trace_id = {traceId: String}
    AND project_id = {projectId: String}
    AND name = {name: String}
    ${timestamp ? `AND start_time >= DATE_SUB({traceTimestamp: DateTime}, ${TRACE_TO_OBSERVATIONS_INTERVAL})` : ""}
    ORDER BY event_ts DESC
  `;
  const rawRecords = await queryDoris<any>({
    query,
    params: {
      traceId,
      projectId,
      name,
      ...(timestamp
        ? { traceTimestamp: convertDateToAnalyticsDateTime(timestamp) }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "list",
      projectId,
    },
  });

  // Preprocess + zip parallel metadata arrays into the Record shape
  // convertObservation expects.
  const records = rawRecords.map((r) => {
    const preprocessed = preprocessDorisUsageCostDetails(r);
    return {
      ...preprocessed,
      metadata: zipDorisMetadataArrays(r.metadata_names, r.metadata_values),
    };
  }) as ObservationRecordReadType[];

  return records.map((r) => convertObservation(r));
};

export const getObservationById = async ({
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
  const records = await getObservationByIdInternal({
    id,
    projectId,
    fetchWithInputOutput,
    startTime,
    type,
    traceId,
    renderingProps,
  });
  const mapped = records.map((record) =>
    convertObservation(record, renderingProps),
  );

  mapped.forEach((observation) => {
    recordDistribution(
      "langfuse.query_by_id_age",
      new Date().getTime() - observation.startTime.getTime(),
      {
        table: "observations",
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

export const getObservationsById = async (
  ids: string[],
  projectId: string,
  fetchWithInputOutput: boolean = false,
) => {
  const query = `
    SELECT
      span_id AS id,
      trace_id,
      project_id,
      type,
      parent_span_id AS parent_observation_id,
      start_time,
      end_time,
      name,
      metadata_names,
      metadata_values,
      level,
      status_message,
      version,
      ${fetchWithInputOutput ? "input, output," : ""}
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
      updated_at,
      event_ts
    FROM events_full
    WHERE span_id IN ({ids: Array(String)})
    AND project_id = {projectId: String}
    ORDER BY event_ts DESC
  `;
  const rawRecords = await queryDoris<any>({
    query,
    params: { ids, projectId },
  });

  // Preprocess + zip parallel metadata arrays.
  const records = rawRecords.map((r) => {
    const preprocessed = preprocessDorisUsageCostDetails(r);
    return {
      ...preprocessed,
      metadata: zipDorisMetadataArrays(r.metadata_names, r.metadata_values),
    };
  }) as ObservationRecordReadType[];

  return records.map((r) => convertObservation(r));
};

const getObservationByIdInternal = async ({
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
  const query = `
    SELECT
      span_id AS id,
      trace_id,
      project_id,
      environment,
      type,
      parent_span_id AS parent_observation_id,
      start_time,
      end_time,
      name,
      metadata_names,
      metadata_values,
      level,
      status_message,
      version,
      ${fetchWithInputOutput ? "input, output," : ""}
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
      usage_pricing_tier_id,
      usage_pricing_tier_name,
      tool_definitions,
      tool_calls,
      tool_call_names,
      created_at,
      updated_at,
      event_ts
    FROM events_full
    WHERE span_id = {id: String}
    AND project_id = {projectId: String}
    ${startTime ? `AND DATE(start_time) = DATE({startTime: DateTime})` : ""}
    ${type ? `AND type = {type: String}` : ""}
    ${traceId ? `AND trace_id = {traceId: String}` : ""}
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
      type: "observation",
      kind: "byId",
      projectId,
    },
  });

  // Preprocess Doris JSON-string maps and zip the parallel metadata
  // arrays back into the Record<string, string> the converter expects.
  const records = rawRecords.map((r) => {
    const preprocessed = preprocessDorisUsageCostDetails(r);
    return {
      ...preprocessed,
      metadata: zipDorisMetadataArrays(r.metadata_names, r.metadata_values),
    };
  }) as ObservationRecordReadType[];

  return records;
};

export type ObservationTableQuery = {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  limit?: number;
  offset?: number;
  selectIOAndMetadata?: boolean;
  renderingProps?: RenderingProps;
};

export type ObservationsTableQueryResult = ObservationRecordReadType & {
  latency?: string;
  time_to_first_token?: string;
  trace_tags?: string[];
  trace_name?: string;
  trace_user_id?: string;
  // Tool counts for list view performance (Doris numeric aggregates come back as strings)
  tool_definitions_count?: string;
  tool_calls_count?: string;
};

export const getObservationsTableCount = async (
  opts: ObservationTableQuery,
) => {
  const count = await getObservationsTableInternal<{
    count: string;
  }>({
    ...opts,
    select: "count",
    tags: { kind: "count" },
  });

  return Number(count[0].count);
};

export const getObservationsTableLargeFieldStats = async (
  opts: ObservationTableQuery,
) => {
  const [row] = await getObservationsTableInternal<{
    avg_input_bytes: string | number | null;
    avg_output_bytes: string | number | null;
    avg_metadata_bytes: string | number | null;
  }>({
    ...opts,
    select: "largeFieldStats",
    tags: { kind: "analytic" },
  });

  return {
    avgInputBytes: Number(row?.avg_input_bytes ?? 0),
    avgOutputBytes: Number(row?.avg_output_bytes ?? 0),
    avgMetadataBytes: Number(row?.avg_metadata_bytes ?? 0),
  };
};

export const getObservationsTableWithModelData = async (
  opts: ObservationTableQuery,
): Promise<FullObservations> => {
  const observationRecords = await getObservationsTableInternal<
    Omit<
      ObservationsTableQueryResult,
      "trace_tags" | "trace_name" | "trace_user_id"
    >
  >({
    ...opts,
    select: "rows",
    tags: { kind: "list" },
  });

  const uniqueModels: string[] = Array.from(
    new Set(
      observationRecords
        .map((r) => r.internal_model_id)
        .filter((r): r is string => Boolean(r)),
    ),
  );

  const [models, traces] = await Promise.all([
    uniqueModels.length > 0
      ? prisma.model.findMany({
          where: {
            id: {
              in: uniqueModels,
            },
            OR: [{ projectId: opts.projectId }, { projectId: null }],
          },
          include: {
            Price: true,
          },
        })
      : [],
    getTracesByIds(
      observationRecords
        .map((o) => o.trace_id)
        .filter((o): o is string => Boolean(o)),
      opts.projectId,
    ),
  ]);

  return observationRecords.map((o) => {
    const trace = traces.find((t) => t.id === o.trace_id);
    const model = models.find((m) => m.id === o.internal_model_id);
    return {
      ...convertObservation(o),
      latency: o.latency ? Number(o.latency) / 1000 : null,
      timeToFirstToken: o.time_to_first_token
        ? Number(o.time_to_first_token) / 1000
        : null,
      traceName: trace?.name ?? null,
      traceTags: trace?.tags ?? [],
      traceTimestamp: trace?.timestamp ?? null,
      userId: trace?.userId ?? null,
      // Tool counts for list view (actual data in toolDefinitions/toolCalls from domain)
      toolDefinitionsCount: o.tool_definitions_count
        ? Number(o.tool_definitions_count)
        : null,
      toolCallsCount: o.tool_calls_count ? Number(o.tool_calls_count) : null,
      ...enrichObservationWithModelData(model),
    };
  });
};

const getObservationsTableInternal = async <T>(
  opts: ObservationTableQuery & {
    select: "count" | "rows" | "largeFieldStats";
    tags: Record<string, string>;
  },
): Promise<Array<T>> => {
  const dorisSelect =
    opts.select === "count"
      ? "count(*) as count"
      : opts.select === "largeFieldStats"
        ? `
          AVG(COALESCE(CHAR_LENGTH(CAST(o.input AS STRING)), 0)) as avg_input_bytes,
          AVG(COALESCE(CHAR_LENGTH(CAST(o.output AS STRING)), 0)) as avg_output_bytes,
          AVG(
            COALESCE(CHAR_LENGTH(CAST(o.metadata_names AS STRING)), 0) +
            COALESCE(CHAR_LENGTH(CAST(o.metadata_values AS STRING)), 0)
          ) as avg_metadata_bytes
        `
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
        COALESCE(NULLIF(o.environment, ''), t.environment) as environment,
        o.status_message as status_message,
        o.version as version,
        o.parent_span_id as parent_observation_id,
        o.created_at as created_at,
        o.updated_at as updated_at,
        o.provided_model_name as provided_model_name,
        o.total_cost as total_cost,
        o.prompt_id as prompt_id,
        o.prompt_name as prompt_name,
        o.prompt_version as prompt_version,
        o.model_id as internal_model_id,
        if(isNull(o.end_time), NULL, milliseconds_diff(o.end_time, o.start_time)) as latency,
        if(isNull(o.completion_start_time), NULL, milliseconds_diff(o.completion_start_time, o.start_time)) as time_to_first_token,
        ifnull(map_size(o.tool_definitions), 0) as tool_definitions_count,
        ifnull(size(o.tool_calls), 0) as tool_calls_count`;

  const { projectId, filter, selectIOAndMetadata, limit, offset, orderBy } =
    opts;

  const dorisSelectString = selectIOAndMetadata
    ? `
      ${dorisSelect},
      o.input,
      o.output,
      o.metadata_names,
      o.metadata_values
    `
    : dorisSelect;

  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const timeFilter = opts.filter.find(
    (f) =>
      f.column === "Start Time" && (f.operator === ">=" || f.operator === ">"),
  );

  const hasScoresFilter = filter.some((f) =>
    f.column.toLowerCase().includes("score"),
  );

  // Phase C: trace-level fields are denormalized onto every observation
  // row by createEventRecord, so in the common case `o.environment` etc
  // are already correct. The LEFT JOIN below targets the root span of
  // the trace (parent_span_id = '') and supplies COALESCE fallbacks for
  // edge cases where the child obs's trace-level fields are empty (out-
  // of-order ingest, OTel child spans without `langfuse.trace.*`
  // attributes). The JOIN is a point-lookup on the inverted trace_id
  // index — millisecond cost on a 50-row page.
  const search = dorisSearchCondition(opts.searchQuery, opts.searchType, {
    type: "observations",
  });

  // Scores CTE for Doris.
  // scores_avg uses Array<Struct(name, avg_value)> to match CK's Array<Tuple>
  // semantics. NumberObjectFilter uses array_filter + struct_element to
  // OR-match any struct where name=key and value satisfies the threshold.
  // This preserves multi-evaluator rows (same score name with different
  // comments) which matter for LLM-as-a-judge evaluation workflows.
  // score_categories stays as Array<"name:value"> because CategoryOptionsFilter
  // uses arrays_overlap(column, array(...)) which expects a string array.
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
          avg(value) avg_value,
          string_value,
          data_type,
          comment
        FROM scores
        WHERE project_id = {projectId: String}
        ${timeFilter ? `AND timestamp >= {timeFilterValue: DateTime}` : ""}
        GROUP BY
          trace_id,
          observation_id,
          name,
          string_value,
          data_type,
          comment
        ORDER BY
          trace_id
        ) tmp
      GROUP BY
        trace_id,
        observation_id
    )`
    : "";

  const dorisOrderBy = orderByToDorisSQL(
    orderBy ? [orderBy] : null,
    observationsTableUiColumnDefinitionsForDoris,
  );

  // Phase C: LEFT JOIN root span of the trace (parent_span_id = '').
  // Used as a COALESCE(o.x, t.x) fallback for trace-level fields when the
  // observation row itself missed denormalization (out-of-order ingest,
  // OTel child spans without `langfuse.trace.*`). trace_id is inverted-
  // indexed; Doris MoW UNIQUE KEY makes this a point-lookup, < 1ms / row.
  const query = `
      ${scoresCte}
      SELECT ${dorisSelectString}
      FROM events_full o
               LEFT JOIN events_full t
                 ON t.project_id = o.project_id
                AND t.trace_id = o.trace_id
                AND t.parent_span_id = ''
               ${hasScoresFilter ? `LEFT JOIN scores_agg AS s ON s.trace_id = o.trace_id and s.observation_id = o.span_id` : ""}
      WHERE ${appliedObservationsFilter.query}
                   ${search.query}
        ${dorisOrderBy}
        ${limit !== undefined && offset !== undefined ? `LIMIT ${limit} OFFSET ${offset}` : ""};`;

  const res = await queryDoris<T>({
    query,
    params: {
      projectId,
      ...appliedObservationsFilter.params,
      ...(timeFilter
        ? {
            timeFilterValue: convertDateToAnalyticsDateTime(
              timeFilter.value as Date,
            ),
          }
        : {}),
      ...search.params,
    },
    tags: {
      ...(opts.tags ?? {}),
      feature: "tracing",
      type: "observation",
      projectId,
    },
  });

  // Doris MySQL protocol returns MAP columns as strings.
  // Parse them into objects so downstream converters work correctly.
  // For selectIOAndMetadata=true rows, zip the parallel metadata arrays
  // (events_full storage layout) back into the Record<string, string>
  // shape that convertObservation expects.
  return res.map((r) => {
    const preprocessed = preprocessDorisUsageCostDetails(r) as Record<
      string,
      unknown
    >;
    if (selectIOAndMetadata) {
      preprocessed.metadata = zipDorisMetadataArrays(
        preprocessed.metadata_names,
        preprocessed.metadata_values,
      );
      delete preprocessed.metadata_names;
      delete preprocessed.metadata_values;
    }
    return preprocessed as T;
  });
};

export const getObservationsGroupedByModel = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const query = `
    SELECT o.provided_model_name as name
    FROM events_full o
    WHERE ${appliedObservationsFilter.query}
    AND o.type = 'GENERATION'
    GROUP BY o.provided_model_name
    ORDER BY count(*) DESC
    LIMIT 1000;
  `;

  const res = await queryDoris<{ name: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ model: r.name }));
};

export const getObservationsGroupedByModelId = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const query = `
      SELECT o.model_id as modelId
      FROM events_full o
      WHERE ${appliedObservationsFilter.query}
      AND o.type = 'GENERATION'
      GROUP BY o.model_id
      ORDER BY count() DESC
      LIMIT 1000;
    `;

  const res = await queryDoris<{ modelId: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });
  return res.map((r) => ({ modelId: r.modelId }));
};

export const getObservationsGroupedByName = async (
  projectId: string,
  filter: FilterState,
  type: ObservationType | null = "GENERATION",
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const query = `
      SELECT o.name as name
      FROM events_full o
      WHERE ${appliedObservationsFilter.query}
      AND o.type = 'GENERATION'
      GROUP BY o.name
      ORDER BY count() DESC
      LIMIT 1000;
    `;

  const res = await queryDoris<{ name: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });
  return res;
};

export const getObservationsGroupedByToolName = async (
  projectId: string,
  filter: FilterState,
) => {
  // Doris does not have tool_definitions column; return empty
  return [] as { toolName: string }[];
};

export const getObservationsGroupedByCalledToolName = async (
  projectId: string,
  filter: FilterState,
) => {
  // Doris does not have tool_call_names column; return empty
  return [] as { calledToolName: string }[];
};

export const getObservationsGroupedByPromptName = async (
  projectId: string,
  filter: FilterState,
) => {
  const { observationsFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  observationsFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitionsForDoris,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const query = `
      SELECT o.prompt_id as id
      FROM events_full o
      WHERE ${appliedObservationsFilter.query}
      AND o.type = 'GENERATION'
      AND o.prompt_id IS NOT NULL
      GROUP BY o.prompt_id
      ORDER BY count() DESC
      LIMIT 1000;
    `;

  const res = await queryDoris<{ id: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  const prompts = res.map((r) => r.id).filter((r): r is string => Boolean(r));

  const pgPrompts =
    prompts.length > 0
      ? await prisma.prompt.findMany({
          select: {
            id: true,
            name: true,
          },
          where: {
            id: {
              in: prompts,
            },
            projectId,
          },
        })
      : [];

  return pgPrompts.map((p) => ({
    promptName: p.name,
  }));
};

export const getCostForTraces = async (
  projectId: string,
  timestamp: Date,
  traceIds: string[],
) => {
  const query = `
        SELECT sum(total_cost) as total_cost
        FROM events_full o
        WHERE o.project_id = {projectId: String}
        AND o.trace_id IN ({traceIds: Array(String)})
        AND o.start_time >= DATE_SUB({timestamp: DateTime}, ${OBSERVATIONS_TO_TRACE_INTERVAL})
      `;

  const res = await queryDoris<{ total_cost: string }>({
    query,
    params: {
      projectId,
      traceIds,
      timestamp: convertDateToAnalyticsDateTime(timestamp),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  return Number(res[0]?.total_cost ?? 0);
};

export const deleteObservationsByTraceIds = async (
  projectId: string,
  traceIds: string[],
) => {
  const query = `
      DELETE FROM events_full
      WHERE project_id = {projectId: String}
      AND trace_id IN ({traceIds: Array(String)})
    `;
  await commandDoris({
    query: query,
    params: {
      projectId,
      traceIds,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "delete",
      projectId,
    },
  });
  return;
};

export const hasAnyObservation = async (projectId: string) => {
  const query = `
      SELECT 1
      FROM events_full
      WHERE project_id = {projectId: String}
      LIMIT 1
    `;

  const rows = await queryDoris<{ 1: number }>({
    query,
    params: { projectId },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "hasAny",
      projectId,
    },
  });

  return rows.length > 0;
};

export const deleteObservationsByProjectId = async (
  projectId: string,
): Promise<boolean> => {
  const query = `
      DELETE FROM events_full
      WHERE project_id = {projectId: String}
    `;
  await commandDoris({
    query: query,
    params: {
      projectId,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "delete",
      projectId,
    },
  });
  return true;
};

export const hasAnyObservationOlderThan = async (
  projectId: string,
  beforeDate: Date,
) => {
  const query = `
      SELECT 1
      FROM events_full
      WHERE project_id = {projectId: String}
      AND start_time < {cutoffDate: DateTime}
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
      type: "observation",
      kind: "hasAnyOlderThan",
      projectId,
    },
  });

  return rows.length > 0;
};

export const deleteObservationsOlderThanDays = async (
  projectId: string,
  beforeDate: Date,
): Promise<boolean> => {
  const query = `
      DELETE FROM events_full
      WHERE project_id = {projectId: String}
      AND start_time < {cutoffDate: DateTime};
    `;
  await commandDoris({
    query: query,
    params: {
      projectId,
      cutoffDate: convertDateToAnalyticsDateTime(beforeDate),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "delete",
      projectId,
    },
  });
  return true;
};

export const getObservationsWithPromptName = async (
  projectId: string,
  promptNames: string[],
) => {
  const query = `
      SELECT count(*) as count, prompt_name
      FROM events_full
      WHERE project_id = {projectId: String}
      AND prompt_name IN ({promptNames: Array(String)})
      AND prompt_name IS NOT NULL
      GROUP BY prompt_name
    `;
  const rows = await queryDoris<{ count: string; prompt_name: string }>({
    query: query,
    params: {
      projectId,
      promptNames,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "list",
      projectId,
    },
  });

  return rows.map((r) => ({
    count: Number(r.count),
    promptName: r.prompt_name,
  }));
};

export const getObservationMetricsForPrompts = async (
  projectId: string,
  promptIds: string[],
) => {
  const query = `
        WITH latencies AS
            (
                SELECT
                    prompt_id,
                    prompt_version,
                    start_time,
                    end_time,
                    usage_details,
                    cost_details,
                    milliseconds_diff(end_time, start_time) AS latency_ms
                FROM events_full
                WHERE (type = 'GENERATION')
                AND (prompt_name IS NOT NULL)
                AND project_id={projectId: String}
                AND prompt_id IN ({promptIds: Array(String)})
            )
        SELECT
            count(*) AS count,
            prompt_id,
            prompt_version,
            min(start_time) AS first_observation,
            max(start_time) AS last_observation,
            percentile_approx(
              COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(usage_details), map_keys(usage_details))), 0), 0.5) AS median_input_usage,
            percentile_approx(
              COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(usage_details), map_keys(usage_details))), 0), 0.5) AS median_output_usage,
            percentile_approx(
              CASE WHEN MAP_CONTAINS_KEY(cost_details,'total') THEN 
                cost_details['total'] ELSE 0 END, 0.5) AS median_total_cost,
            percentile_approx(latency_ms, 0.5) AS median_latency_ms
        FROM latencies
        GROUP BY
            prompt_id,
            prompt_version
        ORDER BY prompt_version DESC
    `;
  const rows = await queryDoris<{
    count: string;
    prompt_id: string;
    prompt_version: number;
    first_observation: string;
    last_observation: string;
    median_input_usage: string;
    median_output_usage: string;
    median_total_cost: string;
    median_latency_ms: string;
  }>({
    query: query,
    params: {
      projectId,
      promptIds,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  return rows.map((r) => ({
    count: Number(r.count),
    promptId: r.prompt_id,
    promptVersion: r.prompt_version,
    firstObservation: parseDorisUTCDateTimeFormat(r.first_observation),
    lastObservation: parseDorisUTCDateTimeFormat(r.last_observation),
    medianInputUsage: Number(r.median_input_usage),
    medianOutputUsage: Number(r.median_output_usage),
    medianTotalCost: Number(r.median_total_cost),
    medianLatencyMs: Number(r.median_latency_ms),
  }));
};

export const getLatencyAndTotalCostForObservations = async (
  projectId: string,
  observationIds: string[],
  timestamp?: Date,
) => {
  const query = `
      SELECT
          span_id AS id,
          COALESCE(total_cost, 0) AS total_cost,
          milliseconds_diff(end_time, start_time) AS latency_ms
      FROM events_full
      WHERE project_id = {projectId: String}
      AND span_id IN ({observationIds: Array(String)})
      ${timestamp ? `AND start_time >= {timestamp: DateTime}` : ""}
    `;
  const rows = await queryDoris<{
    id: string;
    total_cost: string;
    latency_ms: string;
  }>({
    query: query,
    params: {
      projectId,
      observationIds,
      ...(timestamp
        ? { timestamp: convertDateToAnalyticsDateTime(timestamp) }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    totalCost: Number(r.total_cost),
    latency: Number(r.latency_ms) / 1000,
  }));
};

export const getLatencyAndTotalCostForObservationsByTraces = async (
  projectId: string,
  traceIds: string[],
  timestamp?: Date,
) => {
  const query = `
      SELECT
          trace_id,
          sum(COALESCE(total_cost, 0)) AS total_cost,
          milliseconds_diff(max(end_time), min(start_time)) AS latency_ms
      FROM events_full
      WHERE project_id = {projectId: String}
      AND trace_id IN ({traceIds: Array(String)})
      ${timestamp ? `AND start_time >= {timestamp: DateTime}` : ""}
      GROUP BY trace_id
    `;
  const rows = await queryDoris<{
    trace_id: string;
    total_cost: string;
    latency_ms: string;
  }>({
    query: query,
    params: {
      projectId,
      traceIds,
      ...(timestamp
        ? { timestamp: convertDateToAnalyticsDateTime(timestamp) }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  return rows.map((r) => ({
    traceId: r.trace_id,
    totalCost: Number(r.total_cost),
    latency: Number(r.latency_ms) / 1000,
  }));
};

/**
 * Tuple type for observation data returned by per-trace aggregation.
 */
export type ObservationTuple = [
  id: string,
  parentObservationId: string | null,
  totalCost: string,
  inputCost: string,
  outputCost: string,
  latencyMs: number,
];

/**
 * Get observations grouped by trace ID with cost and latency data
 *
 * This is a pure data-fetching function that returns observations organized by trace.
 * For business logic like recursive cost calculations, use the utility functions
 * in the utils layer.
 */
export const getObservationsGroupedByTraceId = async (
  projectId: string,
  traceIds: string[],
  timestamp?: Date,
): Promise<Map<string, ObservationTuple[]>> => {
  if (traceIds.length === 0) return new Map();

  const query = `
      SELECT
          trace_id,
          span_id AS id,
          parent_span_id AS parent_observation_id,
          COALESCE(total_cost, 0) AS total_cost,
          CASE WHEN MAP_CONTAINS_KEY(cost_details,'input') THEN cost_details['input'] ELSE 0 END AS input_cost,
          CASE WHEN MAP_CONTAINS_KEY(cost_details,'output') THEN cost_details['output'] ELSE 0 END AS output_cost,
          milliseconds_diff(end_time, start_time) AS latency_ms
      FROM events_full
      WHERE project_id = {projectId: String}
      AND trace_id IN ({traceIds: Array(String)})
      ${timestamp ? `AND start_time >= {timestamp: DateTime}` : ""}
    `;

  const rows = await queryDoris<{
    trace_id: string;
    id: string;
    parent_observation_id: string | null;
    total_cost: string;
    input_cost: string;
    output_cost: string;
    latency_ms: number;
  }>({
    query,
    params: {
      projectId,
      traceIds,
      ...(timestamp
        ? { timestamp: convertDateToAnalyticsDateTime(timestamp) }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  // Group by trace_id and convert to tuple format
  const result = new Map<string, ObservationTuple[]>();
  for (const row of rows) {
    const tuple: ObservationTuple = [
      row.id,
      row.parent_observation_id,
      String(row.total_cost),
      String(row.input_cost),
      String(row.output_cost),
      row.latency_ms ?? 0,
    ];
    const existing = result.get(row.trace_id) ?? [];
    existing.push(tuple);
    result.set(row.trace_id, existing);
  }
  return result;
};

export const getObservationCountsByProjectInCreationInterval = async ({
  start,
  end,
}: {
  start: Date;
  end: Date;
}) => {
  const query = `
      SELECT
        project_id,
        count(*) as count
      FROM events_full
      WHERE created_at >= {start: DateTime}
      AND created_at < {end: DateTime}
      GROUP BY project_id
    `;

  const rows = await queryDoris<{ project_id: string; count: string }>({
    query,
    params: {
      start: convertDateToAnalyticsDateTime(start),
      end: convertDateToAnalyticsDateTime(end),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
    },
  });

  return rows.map((row) => ({
    projectId: row.project_id,
    count: Number(row.count),
  }));
};

export const getObservationCountOfProjectsSinceCreationDate = async ({
  projectIds,
  start,
}: {
  projectIds: string[];
  start: Date;
}) => {
  const query = `
      SELECT
        count(*) as count
      FROM events_full
      WHERE project_id IN ({projectIds: Array(String)})
      AND created_at >= {start: DateTime}
    `;

  const rows = await queryDoris<{ count: string }>({
    query,
    params: {
      projectIds,
      start: convertDateToAnalyticsDateTime(start),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
    },
  });

  return Number(rows[0]?.count ?? 0);
};

export const getTraceIdsForObservations = async (
  projectId: string,
  observationIds: string[],
) => {
  const query = `
      SELECT
        trace_id,
        span_id AS id
      FROM events_full
      WHERE project_id = {projectId: String}
      AND span_id IN ({observationIds: Array(String)})
    `;

  const rows = await queryDoris<{ id: string; trace_id: string }>({
    query,
    params: {
      projectId,
      observationIds,
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
  }));
};

export const getObservationsForBlobStorageExport = function (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
) {
  const query = `
      SELECT
        span_id AS id,
        trace_id,
        project_id,
        environment,
        type,
        parent_span_id AS parent_observation_id,
        start_time,
        end_time,
        name,
        metadata_names,
        metadata_values,
        level,
        status_message,
        version,
        input,
        output,
        provided_model_name,
        model_parameters,
        usage_details,
        cost_details,
        completion_start_time,
        prompt_name,
        prompt_version
      FROM events_full
      WHERE project_id = {projectId: String}
      AND start_time >= {minTimestamp: DateTime}
      AND start_time <= {maxTimestamp: DateTime}
    `;

  const records = queryDorisStream<Record<string, unknown>>({
    query,
    params: {
      projectId,
      minTimestamp: convertDateToAnalyticsDateTime(minTimestamp),
      maxTimestamp: convertDateToAnalyticsDateTime(maxTimestamp),
    },
    tags: {
      feature: "blobstorage",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  return records;
};

export const getGenerationsForAnalyticsIntegrations = async function* (
  projectId: string,
  projectName: string,
  minTimestamp: Date,
  maxTimestamp: Date,
) {
  const query = `
      SELECT
        o.name as name,
        o.start_time as start_time,
        o.span_id as id,
        o.total_cost as total_cost,
        CASE WHEN o.completion_start_time IS NULL THEN NULL
             ELSE milliseconds_diff(o.completion_start_time, o.start_time)
        END as time_to_first_token,
        o.usage_details['input'] as input_tokens,
        o.usage_details['output'] as output_tokens,
        o.usage_details['total'] as total_tokens,
        o.project_id as project_id,
        CASE WHEN o.end_time IS NULL THEN NULL
             ELSE milliseconds_diff(o.end_time, o.start_time) / 1000
        END as latency,
        o.provided_model_name as model,
        o.level as level,
        o.version as version,
        o.trace_id as trace_id,
        COALESCE(NULLIF(o.trace_name, ''), t.name) as trace_name,
        COALESCE(NULLIF(o.session_id, ''), t.session_id) as trace_session_id,
        COALESCE(NULLIF(o.user_id, ''), t.user_id) as trace_user_id,
        COALESCE(NULLIF(o.${dq("release")}, ''), t.${dq("release")}) as trace_release,
        COALESCE(o.tags, t.tags) as trace_tags,
        COALESCE(
          element_at(o.metadata_values, array_position(o.metadata_names, '$posthog_session_id')),
          element_at(t.metadata_values, array_position(t.metadata_names, '$posthog_session_id'))
        ) as posthog_session_id
      FROM events_full o
      LEFT JOIN events_full t
        ON t.project_id = o.project_id
       AND t.trace_id = o.trace_id
       AND t.parent_span_id = ''
      WHERE o.project_id = {projectId: String}
      AND o.start_time >= {minTimestamp: DateTime}
      AND o.start_time <= {maxTimestamp: DateTime}
      AND o.type = 'GENERATION'
    `;

  const records = queryDorisStream<Record<string, unknown>>({
    query,
    params: {
      projectId,
      minTimestamp: convertDateToAnalyticsDateTime(minTimestamp),
      maxTimestamp: convertDateToAnalyticsDateTime(maxTimestamp),
    },
    tags: {
      feature: "posthog",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  const baseUrl = env.NEXTAUTH_URL?.replace("/api/auth", "");
  for await (const record of records) {
    yield {
      timestamp: record.start_time,
      langfuse_generation_name: record.name,
      langfuse_trace_name: record.trace_name,
      langfuse_url: `${baseUrl}/project/${projectId}/traces/${encodeURIComponent(record.trace_id as string)}?observation=${encodeURIComponent(record.id as string)}`,
      langfuse_id: record.id,
      langfuse_cost_usd: record.total_cost,
      langfuse_input_units: record.input_tokens,
      langfuse_output_units: record.output_tokens,
      langfuse_total_units: record.total_tokens,
      langfuse_session_id: record.trace_session_id,
      langfuse_project_id: projectId,
      langfuse_user_id: record.trace_user_id || "langfuse_unknown_user",
      langfuse_latency: record.latency,
      langfuse_time_to_first_token: record.time_to_first_token,
      langfuse_release: record.trace_release,
      langfuse_version: record.version,
      langfuse_model: record.model,
      langfuse_level: record.level,
      langfuse_tags: record.trace_tags,
      langfuse_event_version: "1.0.0",
      $session_id: record.posthog_session_id ?? null,
      $set: {
        langfuse_user_url: record.user_id
          ? `${baseUrl}/project/${projectId}/users/${encodeURIComponent(record.user_id as string)}`
          : null,
      },
    };
  }
  return;
};

/**
 * Get observation counts grouped by project and day within a date range.
 *
 * Returns one row per project per day with the count of observations started on that day.
 * Uses half-open interval [startDate, endDate) for filtering based on start_time.
 *
 * @param startDate - Start of date range (inclusive)
 * @param endDate - End of date range (exclusive)
 * @returns Array of { count, projectId, date } objects
 *
 * @example
 * // Get observation counts for March 1-2, 2024
 * const counts = await getObservationCountsByProjectAndDay({
 *   startDate: new Date('2024-03-01T00:00:00Z'),
 *   endDate: new Date('2024-03-03T00:00:00Z')
 * });
 *
 * Note: Skips using FINAL (double counting risk) for faster and cheaper
 * queries against Doris. Generous 4x overcompensation before blocking allows
 * for usage aggregation to be meaningful.
 */
export const getObservationCountsByProjectAndDay = async ({
  startDate,
  endDate,
}: {
  startDate: Date;
  endDate: Date;
}) => {
  const query = `
      SELECT
        count(*) as count,
        project_id,
        DATE(start_time) as date
      FROM events_full
      WHERE start_time >= {startDate: DateTime}
      AND start_time < {endDate: DateTime}
      GROUP BY project_id, DATE(start_time)
    `;

  const rows = await queryDoris<{
    count: string;
    project_id: string;
    date: string;
  }>({
    query,
    params: {
      startDate: convertDateToAnalyticsDateTime(startDate),
      endDate: convertDateToAnalyticsDateTime(endDate),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "analytic",
    },
  });

  return rows.map((row) => ({
    count: Number(row.count),
    projectId: row.project_id,
    date: row.date,
  }));
};

/**
 * Get total cost grouped by evaluator ID (job_configuration_id) for the last week.
 *
 * @param projectId - Project ID
 * @param evaluatorIds - Array of evaluator IDs (job_configuration_id from metadata)
 * @returns Array of { evaluatorId, totalCost } objects
 */
export const getCostByEvaluatorIds = async (
  projectId: string,
  evaluatorIds: string[],
): Promise<Array<{ evaluatorId: string; totalCost: number }>> => {
  if (evaluatorIds.length === 0) return [];

  // events_full stores metadata as parallel metadata_names + metadata_values
  // arrays (no MAP), so the legacy metadata['key'] reads are rewritten as
  // element_at(values, array_position(names, key)).
  const query = `
      SELECT
        element_at(metadata_values, array_position(metadata_names, 'job_configuration_id')) as evaluator_id,
        sum(COALESCE(total_cost, 0)) as total_cost
      FROM events_full
      WHERE project_id = {projectId: String}
        AND element_at(metadata_values, array_position(metadata_names, 'job_configuration_id')) IN ({evaluatorIds: Array(String)})
        AND type = 'GENERATION'
        AND start_time > DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY element_at(metadata_values, array_position(metadata_names, 'job_configuration_id'))
    `;

  const rows = await queryDoris<{
    evaluator_id: string;
    total_cost: string;
  }>({
    query,
    params: {
      projectId,
      evaluatorIds,
    },
    tags: {
      feature: "evals",
      type: "observation",
      kind: "analytic",
      projectId,
    },
  });

  return rows.map((row) => ({
    evaluatorId: row.evaluator_id,
    totalCost: Number(row.total_cost),
  }));
};
