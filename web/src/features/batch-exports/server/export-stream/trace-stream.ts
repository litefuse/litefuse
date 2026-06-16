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
  tracesTableUiColumnDefinitionsForDoris,
  dorisSearchCondition,
  parseDorisUTCDateTimeFormat,
  StringFilter,
  zipDorisMetadataArrays,
} from "@langfuse/shared/src/server";
import { Readable } from "stream";
import { env } from "@/src/env.mjs";
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
    const columnDef = tracesTableUiColumnDefinitionsForDoris.find(
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
      tracesTableUiColumnDefinitionsForDoris,
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
  });

  // Doris doesn't have FINAL modifier or LIMIT 1 BY, so we use ROW_NUMBER() for deduplication
  // Note: release is a Doris reserved word, so we use trace_release as alias
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
traces_filtered AS (
      SELECT
        t.trace_id as id,
        t.project_id as project_id,
        t.start_time as timestamp,
        t.name as name,
        t.user_id as user_id,
        t.session_id as session_id,
        t.\`release\` as \`release\`,
        t.version as version,
        t.environment as environment,
        t.tags as tags,
        t.bookmarked as bookmarked,
        t.\`public\` as \`public\`,
        t.input as input,
        t.output as output,
        t.metadata_names as metadata_names,
        t.metadata_values as metadata_values,
        s.scores_avg as scores_avg,
        s.score_categories as score_categories,
        s.score_categories_tuples as score_categories_tuples
      FROM events_full t
        LEFT JOIN scores_agg s ON s.trace_id = t.trace_id AND s.project_id = t.project_id
      WHERE t.project_id = {projectId: String}
        AND t.parent_span_id = ''
        ${appliedTracesFilter.query ? `AND ${appliedTracesFilter.query}` : ""}
        ${search.query}
    )
    SELECT
      id,
      project_id,
      timestamp,
      name,
      user_id,
      session_id,
      \`release\`,
      version,
      environment,
      tags,
      bookmarked,
      \`public\`,
      input,
      output,
      metadata_names,
      metadata_values,
      scores_avg,
      score_categories,
      score_categories_tuples
    FROM traces_filtered
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
