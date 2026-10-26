import {
  convertApiProvidedFilterToDorisFilter,
  deriveFilters,
  convertDorisScoreToDomain,
  StringFilter,
  StringOptionsFilter,
  NumberFilter,
  FilterList,
  DateTimeFilter,
  convertDateToAnalyticsDateTime,
  encodeCursorV3,
  scoreDomainToV3,
  parseDorisUTCDateTimeFormat,
  type ApiColumnMapping,
  type ScoreRecordReadType,
  type ScoresCursorV3Type,
  scoresTableUiColumnDefinitions,
  queryDoris,
  dq,
  logger,
} from "@langfuse/shared/src/server";
import {
  filterAndValidateV3GetScoreList,
  InternalServerError,
  removeObjectKeys,
  ScoreDataTypeEnum,
  type ScoreDataTypeType,
  type ScoreFieldGroupV3,
  scoresTableCols,
  type ScoreDomain,
  type FilterState,
} from "@langfuse/shared";
import { tableFor } from "@langfuse/shared/src/server";

/**
 * Converts a ScoreDomain object to API format.
 * For CORRECTION scores, moves longStringValue to stringValue for API compatibility.
 * For other score types, removes longStringValue.
 */
export const convertScoreToPublicApi = <T extends ScoreDomain>(
  score: T,
): Omit<T, "longStringValue"> & { stringValue?: string | null } => {
  if (score.dataType === ScoreDataTypeEnum.CORRECTION) {
    const { longStringValue, ...rest } = score;
    return {
      ...rest,
      stringValue: longStringValue,
    };
  }

  return removeObjectKeys(score, ["longStringValue"]);
};

export type ScoreQueryType = {
  page: number;
  limit: number;
  projectId: string;
  traceId?: string;
  userId?: string;
  name?: string;
  source?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  value?: number;
  scoreId?: string;
  configId?: string;
  sessionId?: string;
  datasetRunId?: string;
  queueId?: string;
  traceTags?: string | string[];
  operator?: string;
  scoreIds?: string[];
  observationId?: string[];
  dataType?: string;
  environment?: string | string[];
  fields?: string[] | null;
  advancedFilters?: FilterState;
};

/**
 * @internal
 * Internal utility function for getting scores by ID.
 * Do not use directly - use ScoresApiService or repository functions instead.
 */
export const _handleGenerateScoresForPublicApi = async ({
  props,
  scoreScope,
  scoreDataTypes,
}: {
  props: ScoreQueryType;
  scoreScope: "traces_only" | "all";
  scoreDataTypes?: readonly ScoreDataTypeType[];
}) => {
  const { scoresFilter, tracesFilter } = generateScoreFilter(
    props,
    scoreDataTypes,
  );
  const appliedScoresFilter = scoresFilter.apply();
  const appliedTracesFilter = tracesFilter.apply();

  // Determine if trace should be included based on fields parameter
  const { includeTrace, needsTraceJoin } = determineTraceJoinRequirement(
    props.fields,
    tracesFilter.length(),
  );

  // Doris uses UNIQUE KEY model, so no deduplication needed (no LIMIT 1 BY / ROW_NUMBER)
  const query = `
        SELECT
            t.user_id as user_id,
            t.tags as tags,
            t.environment as trace_environment,
            s.id as id,
            s.project_id as project_id,
            s.timestamp as timestamp,
            s.environment as environment,
            s.name as name,
            s.${dq("value")} as ${dq("value")},
            s.string_value as string_value,
            s.author_user_id as author_user_id,
            s.created_at as created_at,
            s.updated_at as updated_at,
            s.source as source,
            s.comment as comment,
            to_json(s.metadata) as metadata,
            s.data_type as data_type,
            s.config_id as config_id,
            s.queue_id as queue_id,
            s.trace_id as trace_id,
            s.observation_id as observation_id,
            s.session_id as session_id,
            s.dataset_run_id as dataset_run_id
        FROM scores s
        LEFT JOIN (
              SELECT
                project_id,
                id AS trace_id,
                COALESCE(user_id, '') AS user_id,
                COALESCE(name, '') AS name,
                tags,
                environment,
                start_time
              FROM ${tableFor(props.projectId, "traces_scalar")}
            ) t ON s.trace_id = t.trace_id AND s.project_id = t.project_id
        WHERE
            s.project_id = {projectId: String}
            ${scoreScope === "traces_only" ? "AND s.session_id IS NULL AND s.dataset_run_id IS NULL" : ""}
            ${appliedScoresFilter.query ? `AND ${appliedScoresFilter.query}` : ""}
            ${tracesFilter.length() > 0 ? `AND ${appliedTracesFilter.query}` : ""}
        ORDER BY s.timestamp DESC
        ${props.limit !== undefined && props.page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
        `;

  const records = await queryDoris<
    ScoreRecordReadType & {
      tags: string[];
      user_id: string;
      trace_environment: string;
    }
  >({
    query,
    params: {
      ...appliedScoresFilter.params,
      ...appliedTracesFilter.params,
      projectId: props.projectId,
      ...(props.limit !== undefined ? { limit: props.limit } : {}),
      ...(props.page !== undefined
        ? { offset: (props.page - 1) * props.limit }
        : {}),
    },
  });

  return records.map((record) => {
    const domainScore = convertDorisScoreToDomain(record);
    const apiScore = convertScoreToPublicApi(domainScore);
    return {
      ...apiScore,
      trace:
        record.trace_id !== null
          ? {
              userId: record.user_id,
              tags: record.tags,
              environment: record.trace_environment,
            }
          : null,
    };
  });
};

/**
 * @internal
 * Internal utility function for getting scores by ID.
 * Do not use directly - use ScoresApiService or repository functions instead.
 */
export const _handleGetScoresCountForPublicApi = async ({
  props,
  scoreScope,
  scoreDataTypes,
}: {
  props: ScoreQueryType;
  scoreScope: "traces_only" | "all";
  scoreDataTypes?: readonly ScoreDataTypeType[];
}) => {
  const { scoresFilter, tracesFilter } = generateScoreFilter(
    props,
    scoreDataTypes,
  );
  const appliedScoresFilter = scoresFilter.apply();
  const appliedTracesFilter = tracesFilter.apply();

  // Determine if trace should be included based on fields parameter
  const { includeTrace, needsTraceJoin } = determineTraceJoinRequirement(
    props.fields,
    tracesFilter.length(),
  );

  // Doris uses UNIQUE KEY model, no deduplication needed
  const query = `
        SELECT
          count(*) as count
        FROM
          scores s
            ${
              tracesFilter.length() > 0
                ? `LEFT JOIN (
              SELECT
                project_id,
                id AS trace_id,
                COALESCE(user_id, '') AS user_id,
                COALESCE(name, '') AS name,
                tags,
                environment,
                start_time
              FROM ${tableFor(props.projectId, "traces_scalar")}
            ) t ON s.trace_id = t.trace_id AND s.project_id = t.project_id`
                : ""
            }
        WHERE
          s.project_id = {projectId: String}
        ${scoreScope === "traces_only" ? "AND s.session_id IS NULL AND s.dataset_run_id IS NULL" : ""}
        ${appliedScoresFilter.query ? `AND ${appliedScoresFilter.query}` : ""}
        ${tracesFilter.length() > 0 ? `AND ${appliedTracesFilter.query}` : ""}
        `;

  const records = await queryDoris<{ count: string }>({
    query,
    params: {
      ...appliedScoresFilter.params,
      ...appliedTracesFilter.params,
      projectId: props.projectId,
    },
  });
  return records.map((record) => Number(record.count)).shift();
};

const secureScoreFilterOptions = [
  {
    id: "traceId",
    dorisSelect: "trace_id",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
  {
    id: "observationId",
    dorisSelect: "observation_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "name",
    dorisSelect: "name",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
  {
    id: "source",
    dorisSelect: "source",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
  {
    id: "fromTimestamp",
    dorisSelect: "timestamp",
    operator: ">=" as const,
    dorisTable: "scores",
    filterType: "DateTimeFilter",
    dorisPrefix: "s",
  },
  {
    id: "toTimestamp",
    dorisSelect: "timestamp",
    operator: "<" as const,
    dorisTable: "scores",
    filterType: "DateTimeFilter",
    dorisPrefix: "s",
  },
  {
    id: "value",
    dorisSelect: "value",
    dorisTable: "scores",
    filterType: "NumberFilter",
    dorisPrefix: "s",
  },
  {
    id: "scoreIds",
    dorisSelect: "id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "configId",
    dorisSelect: "config_id",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
  {
    id: "sessionId",
    dorisSelect: "session_id",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
  {
    id: "datasetRunId",
    dorisSelect: "dataset_run_id",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
  {
    id: "queueId",
    dorisSelect: "queue_id",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
  {
    id: "environment",
    dorisSelect: "environment",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "dataType",
    dorisSelect: "data_type",
    dorisTable: "scores",
    filterType: "StringFilter",
    dorisPrefix: "s",
  },
];

const secureTraceFilterOptions = [
  {
    id: "traceTags",
    dorisSelect: "tags",
    dorisTable: "traces",
    filterType: "ArrayOptionsFilter",
    dorisPrefix: "t",
  },
  {
    id: "userId",
    dorisSelect: "user_id",
    dorisTable: "traces",
    filterType: "StringFilter",
    dorisPrefix: "t",
  },
];

/**
 * Determines if trace join is needed based on fields parameter and trace filters
 */
const determineTraceJoinRequirement = (
  fields: string[] | null | undefined,
  tracesFilterLength: number,
) => {
  const requestedFields = fields ?? ["score", "trace"]; // Default includes both
  const includeTrace = requestedFields.includes("trace");
  const needsTraceJoin = includeTrace || tracesFilterLength > 0;

  return { includeTrace, needsTraceJoin };
};

const generateScoreFilter = (
  filter: ScoreQueryType,
  scoreDataTypes?: readonly ScoreDataTypeType[],
) => {
  const scoresFilter = deriveFilters(
    filter,
    secureScoreFilterOptions,
    filter.advancedFilters,
    scoresTableUiColumnDefinitions,
    scoresTableCols,
  );
  scoresFilter.push(
    new StringFilter({
      table: "scores",
      field: "project_id",
      operator: "=",
      value: filter.projectId,
      tablePrefix: "s",
    }),
  );

  // Add version-based dataType restriction if provided
  // This will AND with any user-provided dataType filter for proper intersection
  if (scoreDataTypes) {
    scoresFilter.push(
      new StringOptionsFilter({
        table: "scores",
        field: "data_type",
        operator: "any of",
        values: [...scoreDataTypes],
        tablePrefix: "s",
      }),
    );
  }

  const tracesFilter = convertApiProvidedFilterToDorisFilter(
    filter,
    secureTraceFilterOptions,
  );

  // If environment is specified AND there are other trace filters (userId, traceTags),
  // also apply the environment filter to traces. This ensures that when filtering by
  // trace properties, the trace's environment matches the requested environment.
  // Without other trace filters, we only filter by the score's own environment,
  // which allows session scores (that have no trace) to be returned correctly.
  if (filter.environment && tracesFilter.length() > 0) {
    const envValues = Array.isArray(filter.environment)
      ? filter.environment
      : [filter.environment];
    tracesFilter.push(
      new StringOptionsFilter({
        table: "traces",
        field: "environment",
        operator: "any of",
        values: envValues,
        tablePrefix: "t",
      }),
    );
  }

  return { scoresFilter, tracesFilter };
};

// ── LITEFUSE PORT ───────────────────────────────────────────────────────────
// `GET /api/public/v3/scores` (upstream Langfuse 4.56.0
// `packages/shared/src/server/repositories/scores.ts::listScoresV3ForPublicApi`
// + `buildV3ListQuery`/`buildDynamicFilters`).
//
// Same contract, same filter semantics and the same cursor scheme as upstream.
// Two deliberate differences, both forced by the storage layer:
//   1. The query is Doris SQL, built with the *existing* public-API score
//      filter machinery (`convertApiProvidedFilterToDorisFilter` +
//      `queryDoris` + `convertDorisScoreToDomain`) instead of ClickHouse's
//      `queryClickhouse`.
//   2. Upstream encodes the cursor as a ClickHouse tuple comparison
//      `(timestamp, id) < (lastTimestamp, lastId)`; Doris has no equivalent we
//      rely on, so the same predicate is spelled out as
//      `timestamp < ts OR (timestamp = ts AND id < lastId)`, which is
//      equivalent for the `timestamp DESC, id DESC` ordering used on both sides.
// The response payload is produced by the shared, storage-agnostic
// `scoreDomainToV3`, so the field set matches upstream field-group by
// field-group.
// ─────────────────────────────────────────────────────────────────────────────

export type ScoresV3QueryType = {
  projectId: string;
  limit: number;
  cursor?: ScoresCursorV3Type;
  fields: ScoreFieldGroupV3[];
  id?: string[];
  name?: string[];
  source?: string[];
  dataType?: string[];
  environment?: string[];
  configId?: string[];
  queueId?: string[];
  authorUserId?: string[];
  value?: string[];
  valueMin?: number;
  valueMax?: number;
  traceId?: string[];
  sessionId?: string[];
  observationId?: string[];
  experimentId?: string[];
  fromTimestamp?: Date;
  toTimestamp?: Date;
};

/**
 * v3 field-group → Doris column projection. Mirrors upstream's
 * `CORE_COLUMNS_V3` / `DETAILS_COLUMNS_V3` / `SUBJECT_COLUMNS_V3` /
 * `ANNOTATION_COLUMNS_V3`, with `metadata` re-selected through `to_json`:
 * Doris renders a MAP<TEXT,TEXT> column by concatenating its raw values without
 * escaping quotes, which makes nested JSON unparseable.
 */
const CORE_COLUMNS_V3 = [
  "s.id as id",
  "s.project_id as project_id",
  "s.timestamp as timestamp",
  "s.environment as environment",
  "s.name as name",
  `s.${dq("value")} as ${dq("value")}`,
  "s.string_value as string_value",
  "s.long_string_value as long_string_value",
  "s.source as source",
  "s.data_type as data_type",
  "s.created_at as created_at",
  "s.updated_at as updated_at",
  "s.execution_trace_id as execution_trace_id",
];
const DETAILS_COLUMNS_V3 = [
  "s.comment as comment",
  "to_json(s.metadata) as metadata",
  "s.config_id as config_id",
];
const SUBJECT_COLUMNS_V3 = [
  "s.trace_id as trace_id",
  "s.observation_id as observation_id",
  "s.session_id as session_id",
  "s.dataset_run_id as dataset_run_id",
];
const ANNOTATION_COLUMNS_V3 = [
  "s.author_user_id as author_user_id",
  "s.queue_id as queue_id",
];

export const buildSelectColumnsV3 = (fields: ScoreFieldGroupV3[]): string => {
  const selected = [...CORE_COLUMNS_V3];
  if (fields.includes("details")) selected.push(...DETAILS_COLUMNS_V3);
  if (fields.includes("subject")) selected.push(...SUBJECT_COLUMNS_V3);
  if (fields.includes("annotation")) selected.push(...ANNOTATION_COLUMNS_V3);
  return selected.join(",\n    ");
};

/**
 * v3 filter → Doris column mapping. Same fields as upstream's
 * `STRING_OPTIONS_FILTERS`, expressed in the existing public-API mapping shape
 * so the SQL is generated by the shared, already-tested filter dialect.
 */
const secureScoreFilterV3Options: ApiColumnMapping[] = [
  {
    id: "id",
    dorisSelect: "id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "name",
    dorisSelect: "name",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "source",
    dorisSelect: "source",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "dataType",
    dorisSelect: "data_type",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "environment",
    dorisSelect: "environment",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "configId",
    dorisSelect: "config_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "queueId",
    dorisSelect: "queue_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "authorUserId",
    dorisSelect: "author_user_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "traceId",
    dorisSelect: "trace_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "sessionId",
    dorisSelect: "session_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "observationId",
    dorisSelect: "observation_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
  {
    id: "experimentId",
    dorisSelect: "dataset_run_id",
    dorisTable: "scores",
    filterType: "StringOptionsFilter",
    dorisPrefix: "s",
  },
];

const escapeDorisStringLiteral = (value: string) => value.replace(/'/g, "''");

/** Upstream `transformBooleanValueForFilter`: "true"/"false" → 1/0. */
const transformBooleanValueForFilter = (v: string): number => {
  if (v === "true") return 1;
  if (v === "false") return 0;
  throw new InternalServerError(
    `transformBooleanValueForFilter received unexpected value: ${v}`,
  );
};

/**
 * Builds the v3 filter clause. Scalar/multi-value filters go through the shared
 * Doris filter builder; `valueMin`/`valueMax` and the polymorphic `value` filter
 * (whose column depends on `dataType`) are added as extra clauses, exactly as
 * upstream's `buildDynamicFilters` does.
 */
export const buildScoresV3Filter = (props: ScoresV3QueryType) => {
  const filterList: FilterList = convertApiProvidedFilterToDorisFilter(
    props as unknown as Record<string, unknown> & {
      page: number;
      limit: number;
      projectId: string;
    },
    secureScoreFilterV3Options,
  );

  filterList.push(
    new StringFilter({
      table: "scores",
      field: "project_id",
      operator: "=",
      value: props.projectId,
      tablePrefix: "s",
    }),
  );

  if (props.fromTimestamp !== undefined) {
    filterList.push(
      new DateTimeFilter({
        table: "scores",
        field: "timestamp",
        operator: ">=",
        value: props.fromTimestamp,
        tablePrefix: "s",
      }),
    );
  }
  if (props.toTimestamp !== undefined) {
    filterList.push(
      new DateTimeFilter({
        table: "scores",
        field: "timestamp",
        operator: "<",
        value: props.toTimestamp,
        tablePrefix: "s",
      }),
    );
  }
  if (props.valueMin !== undefined) {
    filterList.push(
      new NumberFilter({
        table: "scores",
        field: dq("value"),
        operator: ">=",
        value: props.valueMin,
        tablePrefix: "s",
      }),
    );
  }
  if (props.valueMax !== undefined) {
    filterList.push(
      new NumberFilter({
        table: "scores",
        field: dq("value"),
        operator: "<=",
        value: props.valueMax,
        tablePrefix: "s",
      }),
    );
  }

  const compiled = filterList.apply();

  const extraClauses: string[] = [];
  if (props.value?.length && props.dataType?.length === 1) {
    const dt = props.dataType[0] as ScoreDataTypeType;
    switch (dt) {
      case ScoreDataTypeEnum.NUMERIC: {
        const values = props.value.map((v) => {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            throw new InternalServerError(
              `NUMERIC value filter received non-finite value: ${v}`,
            );
          }
          return n;
        });
        extraClauses.push(`s.${dq("value")} IN (${values.join(", ")})`);
        break;
      }
      case ScoreDataTypeEnum.BOOLEAN: {
        const values = props.value.map((v) =>
          transformBooleanValueForFilter(v),
        );
        extraClauses.push(`s.${dq("value")} IN (${values.join(", ")})`);
        break;
      }
      case ScoreDataTypeEnum.CATEGORICAL: {
        const values = props.value.map(
          (v) => `'${escapeDorisStringLiteral(v)}'`,
        );
        extraClauses.push(`s.string_value IN (${values.join(", ")})`);
        break;
      }
      case ScoreDataTypeEnum.TEXT:
      case ScoreDataTypeEnum.CORRECTION:
        throw new InternalServerError(
          `value filter with dataType=${dt} should have been rejected by handler validation`,
        );
      default: {
        const _exhaustiveCheck: never = dt;
        throw new InternalServerError(
          `value filter received unknown dataType: ${_exhaustiveCheck as string}`,
        );
      }
    }
  }

  return [compiled.query, ...extraClauses].filter(Boolean).join(" AND ");
};

/**
 * @internal
 * v3 scores list for the public API. Do not use directly — call it through
 * `ScoresApiService` / the route handler.
 */
export const _handleListScoresV3ForPublicApi = async (
  props: ScoresV3QueryType,
): Promise<{ data: ReturnType<typeof scoreDomainToV3>[]; cursor?: string }> => {
  const filterClause = buildScoresV3Filter(props);

  const cursorClause = props.cursor
    ? `AND (s.timestamp < '${convertDateToAnalyticsDateTime(
        props.cursor.lastTimestamp,
      )}' OR (s.timestamp = '${convertDateToAnalyticsDateTime(
        props.cursor.lastTimestamp,
      )}' AND s.id < '${escapeDorisStringLiteral(props.cursor.lastId)}'))`
    : "";

  // Doris uses the UNIQUE KEY model, so no per-id deduplication is needed
  // (no LIMIT 1 BY / ROW_NUMBER as in the ClickHouse implementation).
  const query = `
        SELECT
            ${buildSelectColumnsV3(props.fields)}
        FROM scores s
        WHERE
            s.project_id = {projectId: String}
            ${cursorClause}
            ${filterClause ? `AND ${filterClause}` : ""}
        ORDER BY s.timestamp DESC, s.id DESC
        LIMIT {limit: Int32}
        `;

  const records = await queryDoris<ScoreRecordReadType>({
    query,
    params: {
      projectId: props.projectId,
      limit: props.limit + 1,
    },
  });

  const hasMore = records.length > props.limit;
  const pageRecords = hasMore ? records.slice(0, props.limit) : records;

  let nextCursor: string | undefined;
  if (hasMore && pageRecords.length > 0) {
    const last = pageRecords[pageRecords.length - 1];
    // The Doris driver hands back either a Date (mysql2 date columns) or the
    // raw string, depending on the connection options — accept both.
    const rawTimestamp: unknown = last.timestamp;
    nextCursor = encodeCursorV3({
      v: 1,
      lastTimestamp:
        rawTimestamp instanceof Date
          ? rawTimestamp
          : parseDorisUTCDateTimeFormat(String(rawTimestamp)),
      lastId: last.id,
    });
  }

  const items: ScoreDomain[] = [];
  for (const row of pageRecords) {
    items.push(convertDorisScoreToDomain(row) as ScoreDomain);
  }

  return {
    data: filterAndValidateV3GetScoreList(
      items.map((score) => scoreDomainToV3(score, props.fields)),
      (error) => {
        logger.error(
          "v3 score row dropped from response: schema validation error",
          {
            issues: error.issues,
            projectId: props.projectId,
          },
        );
      },
    ),
    cursor: nextCursor,
  };
};
// ── END LITEFUSE PORT ───────────────────────────────────────────────────────
