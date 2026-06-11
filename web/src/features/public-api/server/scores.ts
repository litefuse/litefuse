import {
  convertApiProvidedFilterToDorisFilter,
  deriveFilters,
  convertDorisScoreToDomain,
  StringFilter,
  StringOptionsFilter,
  type ScoreRecordReadType,
  scoresTableUiColumnDefinitions,
  queryDoris,
  dq,
} from "@langfuse/shared/src/server";
import {
  removeObjectKeys,
  ScoreDataTypeEnum,
  type ScoreDataTypeType,
  scoresTableCols,
  type ScoreDomain,
  type FilterState,
} from "@langfuse/shared";

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
            s.metadata as metadata,
            s.data_type as data_type,
            s.config_id as config_id,
            s.queue_id as queue_id,
            s.trace_id as trace_id,
            s.observation_id as observation_id,
            s.session_id as session_id,
            s.dataset_run_id as dataset_run_id
        FROM scores s
        LEFT JOIN events_full t ON s.trace_id = t.trace_id AND s.project_id = t.project_id AND t.parent_span_id = ''
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
            ${tracesFilter.length() > 0 ? "LEFT JOIN events_full t ON s.trace_id = t.trace_id AND s.project_id = t.project_id AND t.parent_span_id = ''" : ""}
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
