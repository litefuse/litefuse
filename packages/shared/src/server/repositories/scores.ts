import {
  ScoreDataTypeType,
  ScoreDomain,
  ScoreSourceType,
  AGGREGATABLE_SCORE_TYPES,
  LISTABLE_SCORE_TYPES,
  AggregatableScoreDataType,
} from "../../domain/scores";
import { env } from "../../env";
import { logger } from "../logger";
import { FilterList } from "../queries";
import { FilterCondition, FilterState, TimeFilter } from "../../types";
import { OrderByState } from "../../interfaces/orderBy";
import {
  dashboardColumnDefinitions,
  scoresTableUiColumnDefinitions,
} from "../tableMappings";
import {
  convertScoreAggregation,
  convertDorisScoreToDomain,
  ScoreAggregation,
} from "./scores_converters";
import { SCORE_TO_TRACE_OBSERVATIONS_INTERVAL } from "./constants";
import { ScoreRecordReadType } from "./definitions";
import { _handleGetScoreById, _handleGetScoresByIds } from "./scores-utils";
import { parseMetadataCHRecordToDomain } from "../utils/metadata_conversion";
import { parseDorisStringArray } from "../utils/dorisArrays";
import { recordDistribution } from "../instrumentation";
import { scoresColumnsTableUiColumnDefinitionsForDoris } from "../tableMappings/mapScoresColumnsTable";
import { scoresTableCols } from "../../tableDefinitions/scoresTable";
import { convertDateToAnalyticsDateTime, dq } from "./analytics";
import {
  queryDoris,
  upsertDoris,
  commandDoris,
  queryDorisStream,
  parseDorisUTCDateTimeFormat,
} from "./doris";
import {
  createDorisFilterFromFilterState,
  getDorisProjectIdDefaultFilter,
} from "../queries/doris-sql/factory";
import { orderByToDorisSQL } from "../queries/doris-sql/orderby-factory";

// Helper function to parse timestamps from different backends
const parseTimestamp = (timestamp: string | Date): Date => {
  // Only apply special handling for Doris backend
  if (timestamp instanceof Date) {
    return timestamp;
  }

  // Doris stores timestamps as strings
  if (typeof timestamp === "string") {
    return parseDorisUTCDateTimeFormat(timestamp);
  }

  throw new Error(`Invalid timestamp format: ${typeof timestamp}`);
};

export const searchExistingAnnotationScore = async (
  projectId: string,
  observationId: string | null,
  traceId: string | null,
  sessionId: string | null,
  name: string | undefined,
  configId: string | undefined,
  dataType: ScoreDataTypeType,
) => {
  if (!name && !configId) {
    throw new Error("Either name or configId (or both) must be provided.");
  }

  const query = `
      SELECT *
      FROM scores s
      WHERE s.project_id = {projectId: String}
      AND s.source = 'ANNOTATION'
      AND s.trace_id = {traceId: String}
      ${observationId ? `AND s.observation_id = {observationId: String}` : "AND s.observation_id IS NULL"}
      AND (
        FALSE
        ${name ? `OR s.name = {name: String}` : ""}
        ${configId ? `OR s.config_id = {configId: String}` : ""}
      )
      ORDER BY event_ts DESC
      LIMIT 1
    `;

  const rows = await queryDoris<ScoreRecordReadType>({
    query,
    params: {
      projectId,
      name,
      configId,
      traceId,
      observationId,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });
  return rows.map((row) => convertDorisScoreToDomain(row)).shift();
};

export const getScoreById = async ({
  projectId,
  scoreId,
  source,
}: {
  projectId: string;
  scoreId: string;
  source?: ScoreSourceType;
}): Promise<ScoreDomain | undefined> => {
  return _handleGetScoreById({
    projectId,
    scoreId,
    source,
    scoreScope: "all",
  });
};

export const getScoresByIds = async (
  projectId: string,
  scoreId: string[],
  source?: ScoreSourceType,
): Promise<ScoreDomain[]> => {
  return _handleGetScoresByIds({
    projectId,
    scoreId,
    source,
    scoreScope: "all",
    dataTypes: AGGREGATABLE_SCORE_TYPES,
  });
};

/**
 * Accepts a score in the Doris stream-load row shape.
 * id, project_id, name, and timestamp must always be provided.
 */
export const upsertScore = async (score: Partial<ScoreRecordReadType>) => {
  if (!["id", "project_id", "name", "timestamp"].every((key) => key in score)) {
    throw new Error("Identifier fields must be provided to upsert Score.");
  }

  await upsertDoris({
    table: "scores",
    records: [score as ScoreRecordReadType],
    eventBodyMapper: convertDorisScoreToDomain,
    tags: {
      feature: "tracing",
      type: "score",
      kind: "upsert",
      projectId: score.project_id ?? "",
    },
  });
  return;
};

export type GetScoresForTracesProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  traceIds: string[];
  timestamp?: Date;
  limit?: number;
  offset?: number;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
};

type GetScoresForSessionsProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  sessionIds: string[];
  limit?: number;
  offset?: number;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
};

type GetScoresForDatasetRunsProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  runIds: string[];
  limit?: number;
  offset?: number;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
};

const formatMetadataSelect = (
  excludeMetadata: boolean,
  includeHasMetadata: boolean,
) => {
  // Define explicit column list for Doris (since it doesn't support "* EXCEPT")
  const baseColumns = [
    "project_id",
    "timestamp_date",
    "name",
    "id",
    "timestamp",
    "trace_id",
    "session_id",
    "observation_id",
    dq("value"),
    "source",
    "comment",
    "author_user_id",
    "config_id",
    "data_type",
    "string_value",
    "queue_id",
    "created_at",
    "updated_at",
    "event_ts",
    "is_deleted",
    "environment",
  ];

  const selectColumns = excludeMetadata
    ? baseColumns
    : [...baseColumns, "metadata"];

  return [
    selectColumns.join(", "),
    includeHasMetadata
      ? "CASE WHEN metadata IS NOT NULL AND map_size(metadata) > 0 THEN 1 ELSE 0 END AS has_metadata"
      : null,
  ]
    .filter((s) => s != null)
    .join(", ");
};

export const getScoresForSessions = async <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForSessionsProps<ExcludeMetadata, IncludeHasMetadata>,
) => {
  const {
    projectId,
    sessionIds,
    limit,
    offset,
    excludeMetadata = false,
    includeHasMetadata = false,
  } = props;

  // Return early if sessionIds is empty to avoid "IN (NULL)" query issue
  if (sessionIds.length === 0) {
    return [];
  }

  const select = formatMetadataSelect(excludeMetadata, includeHasMetadata);

  const query = `
        SELECT ${select}
        FROM scores s
        WHERE s.project_id = {projectId: String}
        AND s.session_id IN ({sessionIds: Array(String)})
        AND s.data_type IN (${LISTABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
        ORDER BY event_ts DESC
        ${limit !== undefined && offset !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
      `;

  const rows = await queryDoris<ScoreRecordReadType>({
    query: query,
    params: {
      projectId,
      sessionIds,
      limit,
      offset,
    },
    tags: {
      feature: "sessions",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  const includeMetadataPayloadDoris = excludeMetadata ? false : true;
  return rows.map((r) =>
    convertDorisScoreToDomain(r, includeMetadataPayloadDoris),
  );
};

export const getScoresForDatasetRuns = async <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForDatasetRunsProps<ExcludeMetadata, IncludeHasMetadata>,
) => {
  const {
    projectId,
    runIds,
    limit,
    offset,
    excludeMetadata = false,
    includeHasMetadata = false,
  } = props;

  // Return early if runIds is empty to avoid "IN (NULL)" query issue
  if (runIds.length === 0) {
    return [];
  }

  const select = formatMetadataSelect(excludeMetadata, includeHasMetadata);

  const query = `
        SELECT ${select}
        FROM scores s
        WHERE s.project_id = {projectId: String}
        AND s.dataset_run_id IN ({runIds: Array(String)})
        AND s.data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
        ORDER BY event_ts DESC
        ${limit !== undefined && offset !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
      `;

  const rows = await queryDoris<ScoreRecordReadType>({
    query: query,
    params: {
      projectId,
      runIds,
      limit,
      offset,
    },
    tags: {
      feature: "sessions",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  const includeMetadataPayloadDoris = excludeMetadata ? false : true;
  return rows.map((r) =>
    convertDorisScoreToDomain<ExcludeMetadata, AggregatableScoreDataType>(
      r,
      includeMetadataPayloadDoris,
    ),
  );
};

export const getTraceScoresForDatasetRuns = async (
  projectId: string,
  datasetRunIds: string[],
) => {
  if (datasetRunIds.length === 0) return [];

  // Scores are linked to dataset runs via trace_id in dataset_run_items_rmt.
  // dri.dataset_run_id aliased as run_id so it does not collide with
  // scores.dataset_run_id (which is NULL for EVAL scores).
  const rows = await queryDoris<
    Omit<ScoreRecordReadType, "metadata"> & {
      has_metadata: 0 | 1;
      run_id: string;
    }
  >({
    query: `
      SELECT
        s.id,
        s.timestamp,
        s.project_id,
        s.environment,
        s.trace_id,
        s.session_id,
        s.observation_id,
        s.dataset_run_id,
        s.name,
        s.value,
        s.source,
        s.comment,
        s.author_user_id,
        s.config_id,
        s.data_type,
        s.string_value,
        s.long_string_value,
        s.queue_id,
        s.execution_trace_id,
        s.created_at,
        s.updated_at,
        s.event_ts,
        s.is_deleted,
        CASE WHEN s.metadata IS NOT NULL AND map_size(s.metadata) > 0 THEN 1 ELSE 0 END as has_metadata,
        dri.dataset_run_id as run_id
      FROM scores s
      INNER JOIN (
        SELECT DISTINCT dataset_run_id, trace_id, project_id
        FROM dataset_run_items_rmt
        WHERE project_id = {projectId: String}
          AND dataset_run_id IN ({datasetRunIds: Array(String)})
      ) dri ON s.trace_id = dri.trace_id AND s.project_id = dri.project_id
      WHERE s.project_id = {projectId: String}
        AND s.data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
      ORDER BY s.event_ts DESC
    `,
    params: { projectId, datasetRunIds },
    tags: { feature: "scores", type: "read" },
  });

  const includeMetadataPayload = false;
  return rows.map((row) => ({
    ...convertDorisScoreToDomain<true, AggregatableScoreDataType>(
      { ...row, metadata: {} } as ScoreRecordReadType,
      includeMetadataPayload,
    ),
    datasetRunId: row.run_id,
    hasMetadata: !!row.has_metadata,
  }));
};

const getScoresForTracesInternal = async <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
  DataTypes extends readonly ScoreDataTypeType[],
>(
  props: GetScoresForTracesProps<ExcludeMetadata, IncludeHasMetadata> & {
    dataTypes?: DataTypes;
  },
) => {
  const {
    projectId,
    traceIds,
    timestamp,
    dataTypes,
    limit,
    offset,
    excludeMetadata = false,
    includeHasMetadata = false,
  } = props;

  // Return early if traceIds is empty to avoid "IN (NULL)" query issue
  if (traceIds.length === 0) {
    return [];
  }

  // Use the same formatMetadataSelect function for consistency across all score queries
  const select = formatMetadataSelect(excludeMetadata, includeHasMetadata);

  const query = `
        SELECT ${select}
        FROM scores s
        WHERE s.project_id = {projectId: String}
        AND s.trace_id IN ({traceIds: Array(String)})
        AND s.data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
        ${timestamp ? `AND s.timestamp >= DATE_SUB({traceTimestamp: DateTime}, ${SCORE_TO_TRACE_OBSERVATIONS_INTERVAL})` : ""}
        ORDER BY event_ts DESC
        ${limit !== undefined && offset !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
      `;

  const rows = await queryDoris<
    ScoreRecordReadType & {
      metadata: ExcludeMetadata extends true
        ? never
        : ScoreRecordReadType["metadata"];
      has_metadata: IncludeHasMetadata extends true ? 0 | 1 : never;
    }
  >({
    query: query,
    params: {
      projectId,
      traceIds,
      limit,
      offset,
      ...(timestamp
        ? { traceTimestamp: convertDateToAnalyticsDateTime(timestamp) }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => {
    const score = convertDorisScoreToDomain({
      ...row,
      metadata: excludeMetadata ? {} : row.metadata,
    });

    recordDistribution(
      "langfuse.query_by_id_age",
      new Date().getTime() - score.timestamp.getTime(),
      {
        table: "scores",
      },
    );

    if (includeHasMetadata) {
      Object.assign(score, { hasMetadata: !!row.has_metadata });
    }

    return score;
  });
};

// Used in multiple places, including the public API, hence the non-default exclusion of metadata via excludeMetadata flag
export const getScoresForTraces = async <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForTracesProps<ExcludeMetadata, IncludeHasMetadata>,
) => {
  return getScoresForTracesInternal({
    ...props,
    dataTypes: AGGREGATABLE_SCORE_TYPES,
  });
};

export const getScoresAndCorrectionsForTraces = async <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForTracesProps<ExcludeMetadata, IncludeHasMetadata>,
) => {
  return getScoresForTracesInternal({
    ...props,
  });
};

export type GetScoresForObservationsProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  observationIds: string[];
  limit?: number;
  offset?: number;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
};

// Currently only used from the observations table, hence the exclusion of metadata without excludeMetadata flag
export const getScoresForObservations = async <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForObservationsProps<ExcludeMetadata, IncludeHasMetadata>,
) => {
  const {
    projectId,
    observationIds,
    limit,
    offset,
    excludeMetadata = false,
    includeHasMetadata = false,
  } = props;

  // Return early if observationIds is empty to avoid "IN (NULL)" query issue
  if (observationIds.length === 0) {
    return [];
  }

  // Use the same formatMetadataSelect function for consistency
  const select = formatMetadataSelect(excludeMetadata, includeHasMetadata);

  const query = `
        SELECT ${select}
        FROM scores s
        WHERE s.project_id = {projectId: String}
        AND s.observation_id IN ({observationIds: Array(String)})
        AND s.data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
        ORDER BY event_ts DESC
        ${limit !== undefined && offset !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
      `;

  const rows = await queryDoris<
    ScoreRecordReadType & {
      metadata: ExcludeMetadata extends true
        ? never
        : ScoreRecordReadType["metadata"];
      has_metadata: IncludeHasMetadata extends true ? 0 | 1 : never;
    }
  >({
    query: query,
    params: {
      projectId: projectId,
      observationIds: observationIds,
      limit: limit,
      offset: offset,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => ({
    ...convertDorisScoreToDomain({
      ...row,
      metadata: excludeMetadata ? {} : row.metadata,
    }),
    hasMetadata: (includeHasMetadata
      ? !!row.has_metadata
      : undefined) as IncludeHasMetadata extends true ? boolean : never,
  }));
};

export const getScoresGroupedByNameSourceType = async ({
  projectId,
  filter,
  fromTimestamp,
  toTimestamp,
  dataTypes = AGGREGATABLE_SCORE_TYPES,
}: {
  projectId: string;
  filter: FilterCondition[];
  fromTimestamp?: Date;
  toTimestamp?: Date;
  dataTypes?: readonly ScoreDataTypeType[];
}) => {
  const dorisScoresFilter = new FilterList();

  try {
    dorisScoresFilter.push(
      ...createDorisFilterFromFilterState(
        filter,
        scoresColumnsTableUiColumnDefinitionsForDoris,
      ),
    );
  } catch (error) {
    // If createDorisFilterFromFilterState throws, log and continue with empty filter
    logger.warn(
      `Some filters could not be applied: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const dorisScoresFilterRes = dorisScoresFilter.apply();

  const performDatasetRunItemsJoin = dorisScoresFilter.some(
    (f) => f.table === "dataset_run_items_rmt",
  );

  const query = `
      select
        s.name as name,
        s.source as source,
        s.data_type as data_type
      from scores s
      ${performDatasetRunItemsJoin ? `JOIN dataset_run_items_rmt dri ON s.trace_id = dri.trace_id AND s.project_id = dri.project_id` : ""}
      WHERE s.project_id = {projectId: String}
      ${dorisScoresFilterRes?.query ? `AND ${dorisScoresFilterRes.query}` : ""}
      ${fromTimestamp ? `AND s.timestamp >= {fromTimestamp: DateTime}` : ""}
      ${toTimestamp ? `AND s.timestamp <= {toTimestamp: DateTime}` : ""}
      AND s.data_type IN (${dataTypes.map((t) => `'${t}'`).join(", ")})
      GROUP BY name, source, data_type
      ORDER BY count() desc
      LIMIT 1000;
    `;

  const rows = await queryDoris<{
    name: string;
    source: string;
    data_type: string;
  }>({
    query: query,
    params: {
      projectId: projectId,
      ...(fromTimestamp
        ? { fromTimestamp: convertDateToAnalyticsDateTime(fromTimestamp) }
        : {}),
      ...(toTimestamp
        ? { toTimestamp: convertDateToAnalyticsDateTime(toTimestamp) }
        : {}),
      ...(dorisScoresFilterRes ? dorisScoresFilterRes.params : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => ({
    name: row.name,
    source: row.source as ScoreSourceType,
    dataType: row.data_type as AggregatableScoreDataType,
  }));
};

export const getNumericScoresGroupedByName = async (
  projectId: string,
  timestampFilter?: FilterState,
) => {
  const dorisFilter = timestampFilter
    ? createDorisFilterFromFilterState(timestampFilter, [
        {
          uiTableName: "Timestamp",
          uiTableId: "timestamp",
          tableName: "scores",
          select: "timestamp",
        },
      ])
    : undefined;

  const timestampFilterRes = dorisFilter
    ? new FilterList(dorisFilter).apply()
    : undefined;

  const query = `
        select 
          name as name
        from scores s
        WHERE s.project_id = {projectId: String}
        AND s.data_type IN ('NUMERIC', 'BOOLEAN')
        ${timestampFilterRes?.query ? `AND ${timestampFilterRes.query}` : ""}
        GROUP BY name
        ORDER BY count() desc
        LIMIT 1000;
      `;

  const rows = await queryDoris<{
    name: string;
  }>({
    query: query,
    params: {
      projectId: projectId,
      ...(timestampFilterRes ? timestampFilterRes.params : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows;
};

export const getCategoricalScoresGroupedByName = async (
  projectId: string,
  timestampFilter?: FilterState,
) => {
  const dorisFilter = timestampFilter
    ? createDorisFilterFromFilterState(timestampFilter, [
        {
          uiTableName: "Timestamp",
          uiTableId: "timestamp",
          tableName: "scores",
          select: "timestamp",
        },
      ])
    : undefined;

  const timestampFilterRes = dorisFilter
    ? new FilterList(dorisFilter).apply()
    : undefined;

  const query = `
      SELECT 
        name AS label,
        collect_set(string_value) AS \`values\`
      FROM scores s
      WHERE s.project_id = {projectId: String}
      AND s.data_type = 'CATEGORICAL'
      ${timestampFilterRes?.query ? `AND ${timestampFilterRes.query}` : ""}
      GROUP BY name
      ORDER BY count() DESC
      LIMIT 1000;
    `;

  // Doris ARRAY<STRING> columns (collect_set result) are transmitted over
  // the MySQL protocol as JSON-formatted strings (e.g. '["cat1","cat2"]'),
  // not as native arrays. mysql2 does not auto-parse these. Normalize here
  // so the return type `values: string[]` holds at runtime and downstream
  // callers (e.g. traces.tsx categorical filter) can safely iterate.
  const rows = await queryDoris<{
    label: string;
    values: string | string[] | null;
  }>({
    query: query,
    params: {
      projectId: projectId,
      ...(timestampFilterRes ? timestampFilterRes.params : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => ({
    label: row.label,
    values: parseDorisStringArray(row.values),
  }));
};

export const getScoresUiCount = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  offset?: number;
}) => {
  const rows = await getScoresUiGeneric<{ count: string }>({
    select: "count",
    excludeMetadata: true,
    tags: { kind: "count" },
    ...props,
  });

  return Number(rows[0].count);
};

export type ScoreUiTableRow = ScoreDomain & {
  traceName: string | null;
  traceUserId: string | null;
  traceTags: Array<string> | null;
};

export async function getScoresUiTable<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(props: {
  projectId: string;
  filter: FilterState;
  orderBy: OrderByState;
  limit?: number;
  offset?: number;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadataFlag?: IncludeHasMetadata;
}) {
  const {
    excludeMetadata = false,
    includeHasMetadataFlag = false,
    ...rest
  } = props;

  const rows = await getScoresUiGeneric<{
    id: string;
    project_id: string;
    environment: string;
    name: string;
    value: number;
    string_value: string | null;
    timestamp: string;
    source: string;
    data_type: string;
    comment: string | null;
    trace_id: string | null;
    session_id: string | null;
    dataset_run_id: string | null;
    metadata: Record<string, string>;
    observation_id: string | null;
    author_user_id: string | null;
    user_id: string | null;
    trace_name: string | null;
    trace_tags: Array<string> | null;
    job_configuration_id: string | null;
    author_user_image: string | null;
    author_user_name: string | null;
    config_id: string | null;
    queue_id: string | null;
    execution_trace_id: string | null;
    is_deleted: number;
    event_ts: string;
    created_at: string;
    updated_at: string;
    has_metadata: IncludeHasMetadata extends true ? 0 | 1 : never;
  }>({
    select: "rows",
    tags: { kind: "analytic" },
    excludeMetadata,
    includeHasMetadataFlag,
    ...rest,
  });

  const includeMetadataPayload = excludeMetadata ? false : true;
  return rows.map((row) => {
    // Compute hasMetadata in JS instead of SQL to avoid Doris 5.7.99 bug:
    // CASE expressions on MAP columns inside LEFT JOIN queries trigger
    // __DORIS_GLOBAL_ROWID_COL__ type mismatch.
    const score = convertDorisScoreToDomain(
      {
        ...row,
        metadata: excludeMetadata ? {} : row.metadata,
        // Long string value is never required for scores UI table, so we always return an empty string
        long_string_value: "",
      },
      includeMetadataPayload,
    );
    return {
      ...score,
      traceUserId: row.user_id,
      traceName: row.trace_name,
      traceTags: row.trace_tags,
      hasMetadata: (includeHasMetadataFlag
        ? !!row.has_metadata
        : undefined) as IncludeHasMetadata extends true ? boolean : never,
    };
  });
}

const getScoresUiGeneric = async <T>(props: {
  select: "count" | "rows";
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  offset?: number;
  tags?: Record<string, string>;
  excludeMetadata?: boolean;
  includeHasMetadataFlag?: boolean;
}): Promise<T[]> => {
  const {
    projectId,
    filter,
    orderBy,
    limit,
    offset,
    excludeMetadata = false,
    includeHasMetadataFlag = false,
  } = props;

  const dorisSelect =
    props.select === "count"
      ? "count(*) as count"
      : `
          s.id,
          s.project_id,
          s.environment,
          s.name,
          s.${dq("value")},
          s.string_value,
          s.timestamp,
          s.source,
          s.data_type,
          s.comment,
          ${!excludeMetadata ? "s.metadata," : ""}
          s.trace_id,
          s.session_id,
          s.observation_id,
          s.author_user_id,
          s.created_at,
          s.updated_at,
          s.config_id,
          s.queue_id,
          s.is_deleted,
          s.event_ts
        `;

  const { scoresFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });
  scoresFilter.push(
    ...createDorisFilterFromFilterState(filter, scoresTableUiColumnDefinitions),
  );

  // Separate trace filters from score filters so the subquery branch can
  // apply them to the outer query (after the LEFT JOIN). The flat branch
  // applies both inline since the JOIN is at the same level.
  const traceFilters = scoresFilter.filter((f) => f.table === "traces");
  const scoreOnlyFilters = scoresFilter.filter((f) => f.table !== "traces");
  const scoresOnlyRes = scoreOnlyFilters.apply();
  const traceFiltersRes = traceFilters.apply();

  // Only join traces for rows or if there is a trace filter on counts
  const performTracesJoin =
    props.select === "rows" || traceFilters.length() > 0;

  const orderBySQL = orderByToDorisSQL(
    orderBy ?? null,
    scoresTableUiColumnDefinitions,
  );
  const limitSQL =
    limit !== undefined && offset !== undefined
      ? `limit {limit: Int32} offset {offset: Int32}`
      : "";

  const scoresWhere = `
        WHERE s.project_id = {projectId: String}
        AND s.data_type IN (${LISTABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
        ${scoresOnlyRes?.query ? `AND ${scoresOnlyRes.query}` : ""}
      `;

  const traceWhere = traceFiltersRes?.query
    ? `WHERE ${traceFiltersRes.query}`
    : "";

  let query: string;

  if (includeHasMetadataFlag && performTracesJoin) {
    // Subquery pattern: compute has_metadata before LEFT JOIN to avoid
    // Doris 5.7.99 bug with CASE/map_size on a MAP column inside LEFT JOIN
    // (__DORIS_GLOBAL_ROWID_COL__ type mismatch).
    // Trace filters are applied to the outer query because the subquery
    // only contains scores — the t alias doesn't exist inside it.
    query = `
        SELECT
            sm.id,
            sm.project_id,
            sm.environment,
            sm.name,
            sm.value,
            sm.string_value,
            sm.timestamp,
            sm.source,
            sm.data_type,
            sm.comment,
            ${!excludeMetadata ? "sm.metadata," : ""}
            sm.trace_id,
            sm.session_id,
            sm.observation_id,
            sm.author_user_id,
            sm.created_at,
            sm.updated_at,
            sm.config_id,
            sm.queue_id,
            sm.is_deleted,
            sm.event_ts,
            sm.has_metadata
            ${props.select === "rows" ? `, t.user_id, t.name as trace_name, t.tags as trace_tags` : ""}
        FROM (
            SELECT s.*,
                CASE WHEN s.metadata IS NOT NULL AND map_size(s.metadata) > 0
                     THEN 1 ELSE 0 END AS has_metadata
            FROM scores s
            ${scoresWhere}
            ${orderBySQL}
            ${limitSQL}
        ) sm
        LEFT JOIN events_full t
            ON sm.trace_id = t.trace_id AND t.project_id = sm.project_id AND t.parent_span_id = ''
        ${traceWhere}
        ORDER BY sm.timestamp DESC
      `;
  } else {
    // Flat query — CASE on MAP is safe when there is no LEFT JOIN
    // For count queries, trace columns are only needed by the WHERE clause
    // (via the JOIN), not the SELECT. Including them alongside count(*)
    // triggers "not in aggregate's output" in Doris.
    const traceSelect =
      performTracesJoin && props.select === "rows"
        ? `, t.user_id, t.name as trace_name, t.tags as trace_tags`
        : "";
    const hasMetadataSQL = includeHasMetadataFlag
      ? ", CASE WHEN s.metadata IS NOT NULL AND map_size(s.metadata) > 0 THEN 1 ELSE 0 END AS has_metadata"
      : "";

    // For the flat branch, trace filters can be applied inline since the
    // JOIN is at the same level. Merge both filter result params.
    const flatWhereRes = scoreOnlyFilters.apply();
    // Re-apply trace filters to get their query too (for the inline WHERE)
    const flatWhere = `
        WHERE s.project_id = {projectId: String}
        AND s.data_type IN (${LISTABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
        ${flatWhereRes?.query ? `AND ${flatWhereRes.query}` : ""}
        ${traceFiltersRes?.query ? `AND ${traceFiltersRes.query}` : ""}
      `;
    query = `
        SELECT
            ${dorisSelect}
            ${hasMetadataSQL}
            ${traceSelect}
        FROM scores s
        ${performTracesJoin ? "LEFT JOIN events_full t ON s.trace_id = t.trace_id AND t.project_id = s.project_id AND t.parent_span_id = ''" : ""}
        ${flatWhere}
        ${orderBySQL}
        ${limitSQL}
      `;
  }

  const rows = await queryDoris<T>({
    query: query,
    params: {
      projectId: projectId,
      ...(scoresOnlyRes?.params ?? {}),
      ...(traceFiltersRes?.params ?? {}),
      limit: limit,
      offset: offset,
    },
    tags: {
      ...(props.tags ?? {}),
      feature: "tracing",
      type: "score",
      projectId,
    },
  });

  return rows;
};

export const getScoresUiCountFromEvents = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  offset?: number;
}) => {
  const rows = await getScoresUiGeneric<{ count: string }>({
    select: "count",
    excludeMetadata: true,
    tags: { kind: "count" },
    ...props,
  });

  return Number(rows[0].count);
};

export type ScoreUiTableRowFromEvents = Omit<ScoreDomain, "metadata"> & {
  hasMetadata: boolean;
};

export async function getScoresUiTableFromEvents(props: {
  projectId: string;
  filter: FilterState;
  orderBy: OrderByState;
  limit?: number;
  offset?: number;
}) {
  const rows = await getScoresUiTable<true, true>({
    projectId: props.projectId,
    filter: props.filter,
    orderBy: props.orderBy,
    limit: props.limit,
    offset: props.offset,
    excludeMetadata: true,
    includeHasMetadataFlag: true,
  });

  return rows.map((row) => {
    return {
      ...row,
      hasMetadata: row.hasMetadata ?? false,
    };
  });
}

export const getScoreNames = async (
  projectId: string,
  timestampFilter: FilterState,
) => {
  const dorisFilter = new FilterList(
    createDorisFilterFromFilterState(
      timestampFilter,
      scoresTableUiColumnDefinitions,
    ),
  );
  const timestampFilterRes = dorisFilter.apply();

  const query = `
        select 
          name,
          count(*) as count
        from scores s
        WHERE s.project_id = {projectId: String}
        ${timestampFilterRes?.query ? `AND ${timestampFilterRes.query}` : ""}
        AND s.data_type IN (${LISTABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
        GROUP BY name
        ORDER BY count() desc
        LIMIT 1000;
      `;

  const rows = await queryDoris<{
    name: string;
    count: string;
  }>({
    query,
    params: {
      projectId: projectId,
      ...(timestampFilterRes ? timestampFilterRes.params : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => ({
    name: row.name,
    count: Number(row.count),
  }));
};

export const getScoreStringValues = async (
  projectId: string,
  timestampFilter: FilterState,
) => {
  const dorisFilter = new FilterList(
    createDorisFilterFromFilterState(
      timestampFilter,
      scoresTableUiColumnDefinitions,
    ),
  );
  const timestampFilterRes = dorisFilter.apply();

  const query = `
        select
          string_value,
          count(*) as count
        from scores s
        WHERE s.project_id = {projectId: String}
        AND string_value IS NOT NULL
        AND string_value != ''
        ${timestampFilterRes?.query ? `AND ${timestampFilterRes.query}` : ""}
        GROUP BY string_value
        ORDER BY count(*) desc
        LIMIT 1000;
      `;

  const rows = await queryDoris<{
    string_value: string;
    count: string;
  }>({
    query,
    params: {
      projectId: projectId,
      ...(timestampFilterRes ? timestampFilterRes.params : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => ({
    value: row.string_value,
    count: Number(row.count),
  }));
};

export const deleteScores = async (projectId: string, scoreIds: string[]) => {
  const query = `
      DELETE FROM scores
      WHERE project_id = {projectId: String}
      AND id in ({scoreIds: Array(String)});
    `;
  await commandDoris({
    query: query,
    params: {
      projectId,
      scoreIds,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "delete",
      projectId,
    },
  });
  return;
};

export const deleteScoresByTraceIds = async (
  projectId: string,
  traceIds: string[],
) => {
  const query = `
      DELETE FROM scores
      WHERE project_id = {projectId: String}
      AND trace_id IN ({traceIds: Array(String)});
    `;
  await commandDoris({
    query: query,
    params: {
      projectId,
      traceIds,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "delete",
      projectId,
    },
  });
  return;
};

export const deleteScoresByProjectId = async (
  projectId: string,
): Promise<boolean> => {
  const query = `
      DELETE FROM scores
      WHERE project_id = {projectId: String};
    `;
  await commandDoris({
    query: query,
    params: {
      projectId,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "delete",
      projectId,
    },
  });
  return true;
};

export const hasAnyScoreOlderThan = async (
  projectId: string,
  beforeDate: Date,
) => {
  const query = `
    SELECT 1
    FROM scores
    WHERE project_id = {projectId: String}
    AND timestamp < {cutoffDate: DateTime64(3)}
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
      type: "score",
      kind: "hasAnyOlderThan",
      projectId,
    },
  });

  return rows.length > 0;
};

export const deleteScoresOlderThanDays = async (
  projectId: string,
  beforeDate: Date,
): Promise<boolean> => {
  const query = `
      DELETE FROM scores
      WHERE project_id = {projectId: String}
      AND timestamp < {cutoffDate: DateTime};
    `;
  await commandDoris({
    query: query,
    params: {
      projectId,
      cutoffDate: convertDateToAnalyticsDateTime(beforeDate),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "delete",
      projectId,
    },
  });
  return true;
};

export const getNumericScoreHistogram = async (
  projectId: string,
  filter: FilterState,
  limit: number,
) => {
  const dorisFilter = new FilterList(
    createDorisFilterFromFilterState(filter, dashboardColumnDefinitions),
  );
  const dorisFilterRes = dorisFilter.apply();

  const traceFilter = dorisFilter.find((f) => f.table === "traces");

  const query = `
      SELECT s.value
      FROM scores s
      ${traceFilter ? `LEFT JOIN events_full t ON s.trace_id = t.trace_id AND t.project_id = s.project_id AND t.parent_span_id = ''` : ""}
      WHERE s.project_id = {projectId: String}
      ${traceFilter ? `AND t.project_id = {projectId: String}` : ""}
      ${dorisFilterRes?.query ? `AND ${dorisFilterRes.query}` : ""}
      ORDER BY s.event_ts DESC
      ${limit !== undefined ? `LIMIT {limit: Int32}` : ""}
    `;

  return queryDoris<{ value: number }>({
    query,
    params: {
      projectId,
      limit,
      ...(dorisFilterRes ? dorisFilterRes.params : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "analytic",
      projectId,
    },
  });
};

export const getAggregatedScoresForPrompts = async (
  projectId: string,
  promptIds: string[],
  fetchScoreRelation: "observation" | "trace",
) => {
  const query = `
      SELECT 
        prompt_id,
        s.id,
        s.name,
        s.string_value,
        s.value,
        s.source,
        s.data_type,
        s.comment,
        CASE WHEN s.metadata IS NOT NULL AND map_size(s.metadata) > 0 THEN 1 ELSE 0 END AS has_metadata
      FROM scores s LEFT JOIN events_full o
        ON o.trace_id = s.trace_id
        AND o.project_id = s.project_id
        ${fetchScoreRelation === "observation" ? "AND o.span_id = s.observation_id" : ""}
      WHERE o.project_id = {projectId: String}
      AND s.project_id = {projectId: String}
      AND o.prompt_id IN ({promptIds: Array(String)})
      AND o.type = 'GENERATION'
      AND s.name IS NOT NULL
      ${fetchScoreRelation === "trace" ? "AND s.observation_id IS NULL" : ""}
      AND s.data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
    `;

  const rows = await queryDoris<
    ScoreAggregation & {
      prompt_id: string;
      has_metadata: 0 | 1;
    }
  >({
    query,
    params: {
      projectId,
      promptIds,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "analytic",
      projectId,
    },
  });

  return rows.map((row) => ({
    ...convertScoreAggregation<AggregatableScoreDataType>(row),
    promptId: row.prompt_id,
    hasMetadata: !!row.has_metadata,
  }));
};

export const getScoreCountsByProjectInCreationInterval = async ({
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
      FROM scores
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
      type: "score",
      kind: "analytic",
    },
  });

  return rows.map((row) => ({
    projectId: row.project_id,
    count: Number(row.count),
  }));
};

export const getScoreCountOfProjectsSinceCreationDate = async ({
  projectIds,
  start,
}: {
  projectIds: string[];
  start: Date;
}) => {
  const query = `
      SELECT 
        count(*) as count
      FROM scores
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
      type: "score",
      kind: "analytic",
    },
  });

  return Number(rows[0]?.count ?? 0);
};

export const getDistinctScoreNames = async (p: {
  projectId: string;
  cutoffCreatedAt: Date;
  filter: FilterState;
  isTimestampFilter: (filter: FilterCondition) => filter is TimeFilter;
}) => {
  const { projectId, cutoffCreatedAt, filter, isTimestampFilter } = p;
  const scoreTimestampFilter = filter?.find(isTimestampFilter);

  const query = `
      SELECT DISTINCT
        name
      FROM scores s 
      WHERE s.project_id = {projectId: String}
      AND s.created_at <= {cutoffCreatedAt: DateTime}
      ${scoreTimestampFilter ? `AND s.timestamp >= {filterTimestamp: DateTime}` : ""}
      AND s.data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
    `;

  const rows = await queryDoris<{ name: string }>({
    query,
    params: {
      projectId,
      cutoffCreatedAt: convertDateToAnalyticsDateTime(cutoffCreatedAt),
      ...(scoreTimestampFilter
        ? {
            filterTimestamp: convertDateToAnalyticsDateTime(
              scoreTimestampFilter.value,
            ),
          }
        : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "list",
      projectId,
    },
  });

  return rows.map((row) => row.name);
};

export const getScoresForBlobStorageExport = function (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
) {
  const query = `
      SELECT
        id,
        timestamp,
        project_id,
        environment,
        trace_id,
        observation_id,
        name,
        value,
        source,
        comment,
        data_type,
        string_value
      FROM scores
      WHERE project_id = {projectId: String}
      AND timestamp >= {minTimestamp: DateTime}
      AND timestamp <= {maxTimestamp: DateTime}
      AND data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
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
      type: "score",
      kind: "analytic",
      projectId,
    },
  });

  return records;
};

export const getScoresForAnalyticsIntegrations = async function* (
  projectId: string,
  projectName: string,
  minTimestamp: Date,
  maxTimestamp: Date,
) {
  const query = `
      SELECT
        s.id as id,
        s.timestamp as timestamp,
        s.name as name,
        s.${dq("value")} as ${dq("value")},
        s.comment as comment,
        t.name as trace_name,
        t.session_id as trace_session_id,
        t.user_id as trace_user_id,
        t.${dq("release")} as trace_release,
        t.tags as trace_tags,
        element_at(t.metadata_values, array_position(t.metadata_names, '$posthog_session_id')) as posthog_session_id
      FROM scores s
      LEFT JOIN events_full t ON s.trace_id = t.trace_id AND s.project_id = t.project_id AND t.parent_span_id = ''
      WHERE s.project_id = {projectId: String}
      AND t.project_id = {projectId: String}
      AND s.timestamp >= {minTimestamp: DateTime}
      AND s.timestamp <= {maxTimestamp: DateTime}
      AND s.data_type IN (${AGGREGATABLE_SCORE_TYPES.map((t) => `'${t}'`).join(", ")})
      AND t.start_time >= DATE_SUB({minTimestamp: DateTime}, INTERVAL 7 DAY)
      AND t.start_time <= {maxTimestamp: DateTime}
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
      type: "score",
      kind: "analytic",
      projectId,
    },
  });

  const baseUrl = env.NEXTAUTH_URL?.replace("/api/auth", "");
  for await (const record of records) {
    yield {
      timestamp: record.timestamp,
      langfuse_score_name: record.name,
      langfuse_score_value: record.value,
      langfuse_score_comment: record.comment,
      langfuse_trace_name: record.trace_name,
      langfuse_id: record.id,
      langfuse_session_id: record.trace_session_id,
      langfuse_project_id: projectId,
      langfuse_user_id: record.trace_user_id || "langfuse_unknown_user",
      langfuse_release: record.trace_release,
      langfuse_tags: parseDorisStringArray(record.trace_tags),
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

export const hasAnyScore = async (projectId: string) => {
  const query = `
      SELECT 1
      FROM scores
      WHERE project_id = {projectId: String}
      LIMIT 1
    `;

  const rows = await queryDoris<{ 1: number }>({
    query,
    params: {
      projectId,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "hasAny",
      projectId,
    },
  });

  return rows.length > 0;
};

export const getScoreMetadataById = async (
  projectId: string,
  id: string,
  source?: ScoreSourceType,
) => {
  const query = `
      SELECT metadata
      FROM scores s
      WHERE s.project_id = {projectId: String}
      AND s.id = {id: String}
      ${source ? `AND s.source = {source: String}` : ""}
      LIMIT 1
    `;

  const rows = await queryDoris<Pick<ScoreRecordReadType, "metadata">>({
    query,
    params: {
      projectId,
      id,
      ...(source !== undefined ? { source } : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "getScoreMetadataById",
      projectId,
    },
  });

  return rows
    .map((row) =>
      parseMetadataCHRecordToDomain(row.metadata as Record<string, string>),
    )
    .shift();
};

/**
 * Get score counts grouped by project and day within a date range.
 *
 * Returns one row per project per day with the count of scores created on that day.
 * Uses half-open interval [startDate, endDate) for filtering based on timestamp.
 *
 * @param startDate - Start of date range (inclusive)
 * @param endDate - End of date range (exclusive)
 * @returns Array of { count, projectId, date } objects
 *
 * @example
 * // Get score counts for March 1-2, 2024
 * const counts = await getScoreCountsByProjectAndDay({
 *   startDate: new Date('2024-03-01T00:00:00Z'),
 *   endDate: new Date('2024-03-03T00:00:00Z')
 * });
 *
 * Note: Doris does not have FINAL modifier. Generous 4x overcompensation
 * before blocking allows for usage aggregation to be meaningful.
 *
 */
export const getScoreCountsByProjectAndDay = async ({
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
      CAST(timestamp AS DATE) as date
    FROM scores
    WHERE timestamp >= {startDate: DateTime}
    AND timestamp < {endDate: DateTime}
    AND data_type IN ({dataTypes: Array(String)})
    GROUP BY project_id, CAST(timestamp AS DATE)
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
      dataTypes: AGGREGATABLE_SCORE_TYPES,
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "analytic",
    },
  });

  return rows.map((row) => ({
    count: Number(row.count),
    projectId: row.project_id,
    date: row.date,
  }));
};
