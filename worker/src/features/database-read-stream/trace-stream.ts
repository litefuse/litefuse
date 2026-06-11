import {
  FilterCondition,
  ScoreDataTypeEnum,
  type ScoreDataTypeType,
  TracingSearchType,
} from "@langfuse/shared";
import {
  getDistinctScoreNames,
  queryDorisStream,
  logger,
  FilterList,
  createFilterFromFilterState,
  tracesTableUiColumnDefinitions,
  dorisSearchCondition,
  parseDorisUTCDateTimeFormat,
  StringFilter,
  zipDorisMetadataArrays,
} from "@langfuse/shared/src/server";
import { Readable } from "stream";
import { env } from "../../env";
import {
  getChunkWithFlattenedScores,
  isTraceTimestampFilter,
  prepareScoresForOutput,
} from "./getDatabaseReadStream";
import { fetchCommentsForExport } from "./fetchCommentsForExport";

const BATCH_SIZE = 1000; // Fetch comments in batches for efficiency

export const getTraceStream = async (props: {
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

  // Filter out observation-level filters since we don't join the observations table
  // This prevents batch export failures when observation-level filters are present
  const traceOnlyFilters = (filter ?? []).filter((f) => {
    const columnDef = tracesTableUiColumnDefinitions.find(
      (col) => col.uiTableName === f.column || col.uiTableId === f.column,
    );
    // Keep the filter if it's not an observation-level filter
    return columnDef?.tableName !== "observations";
  });

  // Get distinct score names for empty columns
  const distinctScoreNames = await getDistinctScoreNames({
    projectId,
    cutoffCreatedAt,
    filter: traceOnlyFilters,
    isTimestampFilter: isTraceTimestampFilter,
  });

  const emptyScoreColumns = distinctScoreNames.reduce(
    (acc, name) => ({ ...acc, [name]: null }),
    {} as Record<string, null>,
  );

  // Build filters for traces
  const tracesFilter = new FilterList([]);

  tracesFilter.push(
    ...createFilterFromFilterState(
      [
        ...traceOnlyFilters,
        {
          column: "timestamp",
          operator: "<" as const,
          value: cutoffCreatedAt,
          type: "datetime" as const,
        },
      ],
      tracesTableUiColumnDefinitions,
    ),
  );

  const appliedTracesFilter = tracesFilter.apply();

  const scoresFilter = new FilterList([
    new StringFilter({
      table: "scores",
      field: "project_id",
      operator: "=",
      value: projectId,
    }),
  ]);

  const appliedScoresFilter = scoresFilter.apply();

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "traces",
    hasTracesJoin: false,
  });

  // Aggregate trace fields from events_full using the two-CTE pattern that
  // mirrors langfuse-main's eventsTracesAggregation:
  //   * trace_scalars: scalar trace-level fields via MAX_BY(IF(cond, val, NULL), event_ts)
  //     equivalent to upstream's argMaxIf.
  //   * trace_root: tags / metadata / input / output picked from the latest
  //     parent_span_id = '' root span via ROW_NUMBER().
  // tracesTableUiColumnDefinitions / tracesFilter target column names
  // (timestamp, release, ...) compatible with the legacy traces table —
  // they apply at the trace_scalars level before the LEFT JOIN. Filter
  // params resolve in the events_full WHERE because we don't alias the
  // trace_scalars CTE inputs.
  //
  // metadata is rebuilt at output time from metadata_names / metadata_values
  // parallel arrays (events_full layout) into a Doris MAP that downstream
  // export consumers can serialize.
  const query = `
    WITH scores_agg AS (
      SELECT
        project_id,
        trace_id,
        CONCAT('[', GROUP_CONCAT(DISTINCT JSON_OBJECT('name', name, 'value', avg_val, 'dataType', data_type, 'stringValue', COALESCE(string_value, ''))), ']') AS scores_avg,
        GROUP_CONCAT(
          DISTINCT CONCAT(name, ':', COALESCE(string_value, ''))
        ) AS score_categories,
        CONCAT('[', GROUP_CONCAT(DISTINCT JSON_OBJECT('name', name, 'stringValue', string_value)), ']') AS score_categories_tuples
      FROM (
        SELECT
          project_id,
          trace_id,
          name,
          avg(value) as avg_val,
          data_type,
          string_value
        FROM scores
        WHERE ${appliedScoresFilter.query}
        GROUP BY
          project_id,
          trace_id,
          name,
          data_type,
          string_value
      ) tmp
      GROUP BY project_id, trace_id
    ),
    trace_scalars AS (
      SELECT
        trace_id,
        project_id,
        MIN(start_time) AS \`timestamp\`,
        MAX_BY(IF(trace_name <> '', trace_name, NULL), event_ts) AS name,
        MAX_BY(IF(user_id <> '', user_id, NULL), event_ts) AS user_id,
        MAX_BY(IF(session_id <> '', session_id, NULL), event_ts) AS session_id,
        MAX_BY(IF(\`release\` <> '', \`release\`, NULL), event_ts) AS \`release\`,
        MAX_BY(IF(version <> '', version, NULL), event_ts) AS version,
        MAX_BY(IF(environment <> '', environment, NULL), event_ts) AS environment,
        MAX_BY(IF(parent_span_id = '', bookmarked, NULL), event_ts) AS bookmarked,
        MAX(\`public\`) AS \`public\`
      FROM events_full
      WHERE project_id = {projectId: String}
        ${appliedTracesFilter.query ? `AND ${appliedTracesFilter.query}` : ""}
        ${search.query}
      GROUP BY trace_id, project_id
    ),
    trace_root AS (
      SELECT
        trace_id,
        project_id,
        tags,
        input,
        output,
        metadata_names,
        metadata_values
      FROM (
        SELECT
          trace_id,
          project_id,
          tags,
          input,
          output,
          metadata_names,
          metadata_values,
          ROW_NUMBER() OVER (
            PARTITION BY trace_id, project_id
            ORDER BY event_ts DESC
          ) AS rn
        FROM events_full
        WHERE project_id = {projectId: String}
          AND parent_span_id = ''
      ) ranked
      WHERE rn = 1
    )
    SELECT
      s.trace_id AS id,
      s.project_id AS project_id,
      s.\`timestamp\` AS \`timestamp\`,
      s.name AS name,
      s.user_id AS user_id,
      s.session_id AS session_id,
      s.\`release\` AS \`release\`,
      s.version AS version,
      s.environment AS environment,
      r.tags AS tags,
      s.bookmarked AS bookmarked,
      s.\`public\` AS \`public\`,
      r.input AS input,
      r.output AS output,
      r.metadata_names AS metadata_names,
      r.metadata_values AS metadata_values,
      sa.scores_avg AS scores_avg,
      sa.score_categories AS score_categories,
      sa.score_categories_tuples AS score_categories_tuples
    FROM trace_scalars s
    LEFT JOIN trace_root r
      ON r.trace_id = s.trace_id AND r.project_id = s.project_id
    LEFT JOIN scores_agg sa
      ON sa.trace_id = s.trace_id AND sa.project_id = s.project_id
    LIMIT {rowLimit: Int64}
    `;

  const asyncGenerator = queryDorisStream<{
    id: string;
    project_id: string;
    timestamp: Date;
    name: string | null;
    user_id: string | null;
    session_id: string | null;
    release: string | null;
    version: string | null;
    environment: string | null;
    tags: string[];
    bookmarked: boolean;
    public: boolean;
    input: unknown;
    output: unknown;
    // events_full layout: metadata is split across two parallel arrays;
    // we zip them in the processor below for export.
    metadata_names: unknown;
    metadata_values: unknown;
    scores_avg: string | undefined;
    score_categories: string | undefined;
    score_categories_tuples: string | undefined;
  }>({
    query,
    params: {
      projectId,
      rowLimit,
      ...appliedTracesFilter.params,
      ...appliedScoresFilter.params,
      ...search.params,
    },
    tags: {
      feature: "batch-export",
      type: "trace",
      kind: "export",
      projectId,
    },
  });

  // Helper function to process a single trace row
  const processTraceRow = (
    bufferedRow: Awaited<ReturnType<typeof asyncGenerator.next>>["value"],
    commentsByTrace: Map<string, any[]>,
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

    // Get comments for this trace
    const traceComments = commentsByTrace.get(bufferedRow.id) ?? [];

    return getChunkWithFlattenedScores(
      [
        {
          id: bufferedRow.id,
          timestamp:
            bufferedRow.timestamp instanceof Date
              ? bufferedRow.timestamp
              : parseDorisUTCDateTimeFormat(bufferedRow.timestamp),
          name: bufferedRow.name ?? "",
          userId: bufferedRow.user_id,
          sessionId: bufferedRow.session_id,
          release: bufferedRow.release,
          version: bufferedRow.version,
          environment: bufferedRow.environment ?? undefined,
          tags: bufferedRow.tags,
          bookmarked: bufferedRow.bookmarked,
          public: bufferedRow.public,
          input: bufferedRow.input,
          output: bufferedRow.output,
          // Rebuild metadata Map from parallel arrays for downstream export
          // consumers that expect Record<string, string>.
          metadata: zipDorisMetadataArrays(
            bufferedRow.metadata_names,
            bufferedRow.metadata_values,
          ),
          scores: outputScores,
          comments: traceComments,
        },
      ],
      emptyScoreColumns,
    )[0];
  };

  // Convert async generator to Node.js Readable stream
  let recordsProcessed = 0;

  return Readable.from(
    (async function* () {
      let rowBuffer: Awaited<
        ReturnType<typeof asyncGenerator.next>
      >["value"][] = [];
      let traceIds: string[] = [];

      for await (const row of asyncGenerator) {
        rowBuffer.push(row);
        traceIds.push(row.id);

        // Process in batches
        if (rowBuffer.length >= BATCH_SIZE) {
          // Fetch comments for this batch
          const commentsByTrace = await fetchCommentsForExport(
            projectId,
            "TRACE",
            traceIds,
          );

          // Process each row in the buffer
          for (const bufferedRow of rowBuffer) {
            recordsProcessed++;
            if (recordsProcessed % 10000 === 0)
              logger.info(
                `Streaming traces for project ${projectId}: processed ${recordsProcessed} rows`,
              );

            yield processTraceRow(bufferedRow, commentsByTrace);
          }

          // Reset buffers
          rowBuffer = [];
          traceIds = [];
        }
      }

      // Process remaining rows in buffer
      if (rowBuffer.length > 0) {
        const commentsByTrace = await fetchCommentsForExport(
          projectId,
          "TRACE",
          traceIds,
        );

        for (const bufferedRow of rowBuffer) {
          recordsProcessed++;
          if (recordsProcessed % 10000 === 0)
            logger.info(
              `Streaming traces for project ${projectId}: processed ${recordsProcessed} rows`,
            );

          yield processTraceRow(bufferedRow, commentsByTrace);
        }
      }
    })(),
  );
};
