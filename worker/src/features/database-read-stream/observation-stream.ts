import {
  BatchExportFileFormat,
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
  ObservationRecordReadType,
  StringFilter,
  FilterList,
  createFilterFromFilterState,
  observationsTableUiColumnDefinitions,
  enrichObservationWithModelData,
  dorisSearchCondition,
  convertObservation,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { Readable } from "stream";
import { env } from "../../env";
import {
  getChunkWithFlattenedScores,
  prepareScoresForOutput,
} from "./getDatabaseReadStream";
import { fetchCommentsForExport } from "./fetchCommentsForExport";
import type { Model, Price } from "@prisma/client";

const DEFAULT_BATCH_SIZE = 1000;
const REDUCED_BATCH_SIZE = 200; // Smaller batch for JSON/JSONL which hold parsed objects in memory

type ModelWithPrice = Model & { Price: Price[] };

/**
 * Creates a model cache that fetches models from the database on demand and stores them in memory.
 * Only queries the database if a model ID is not already in the cache.
 *
 * @param projectId - The project ID to filter models by
 * @returns Object with getModel function to retrieve models by ID
 */
const createModelCache = (projectId: string) => {
  const modelCache = new Map<string, ModelWithPrice | null>();

  const getModel = async (
    internalModelId: string | null | undefined,
  ): Promise<ModelWithPrice | null> => {
    if (!internalModelId) return null;

    // Check if model is already in cache
    if (modelCache.has(internalModelId)) {
      return modelCache.get(internalModelId) ?? null;
    }

    // Fetch model from database
    const model = await prisma.model.findFirst({
      where: {
        id: internalModelId,
        OR: [{ projectId }, { projectId: null }],
      },
      include: {
        Price: true,
      },
    });

    // Store in cache (even if null to avoid repeated queries)
    modelCache.set(internalModelId, model);

    logger.debug(`Model ${internalModelId} fetched from database`);
    return model;
  };

  return { getModel };
};

export const getObservationStream = async (props: {
  projectId: string;
  cutoffCreatedAt: Date;
  filter: FilterCondition[] | null;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  rowLimit?: number;
  fileFormat?: BatchExportFileFormat;
}): Promise<Readable> => {
  const {
    projectId,
    cutoffCreatedAt,
    filter = [],
    searchQuery,
    searchType,
    rowLimit = env.BATCH_EXPORT_ROW_LIMIT,
  } = props;

  const isCsv = props.fileFormat === BatchExportFileFormat.CSV;
  const batchSize = isCsv ? DEFAULT_BATCH_SIZE : REDUCED_BATCH_SIZE;

  // Doris doesn't need skipDedup - it doesn't have FINAL modifier

  // Filter out trace-level filters since we don't join the traces table for filtering
  // This prevents batch export failures when trace-level filters are present
  const observationOnlyFilters = (filter ?? []).filter((f) => {
    const columnDef = observationsTableUiColumnDefinitions.find(
      (col) => col.uiTableName === f.column || col.uiTableId === f.column,
    );
    // Keep the filter if it's not a trace-level filter
    return columnDef?.tableName !== "traces";
  });

  const distinctScoreNames = await getDistinctScoreNames({
    projectId,
    cutoffCreatedAt,
    filter: observationOnlyFilters,
    isTimestampFilter: (filter: FilterCondition): filter is TimeFilter => {
      return filter.column === "Start Time" && filter.type === "datetime";
    },
  });

  const scoresFilter = new FilterList([
    new StringFilter({
      dorisTable: "scores",
      field: "project_id",
      operator: "=",
      value: projectId,
    }),
  ]);

  const appliedScoresFilter = scoresFilter.apply();

  const observationsFilter = new FilterList([
    new StringFilter({
      dorisTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      [
        ...observationOnlyFilters,
        {
          column: "startTime",
          operator: "<" as const,
          value: cutoffCreatedAt,
          type: "datetime" as const,
        },
      ],
      observationsTableUiColumnDefinitions,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "observations",
    hasTracesJoin: true,
  });

  // Doris doesn't have FINAL modifier or LIMIT 1 BY, so we use ROW_NUMBER() for deduplication
  const query = `
      WITH scores_agg AS (
        SELECT
          trace_id,
          observation_id,
          CONCAT('[', GROUP_CONCAT(DISTINCT JSON_OBJECT('name', name, 'value', avg_val, 'dataType', data_type, 'stringValue', COALESCE(string_value, ''))), ']') AS scores_avg,
          GROUP_CONCAT(
            DISTINCT CONCAT(name, ':', COALESCE(string_value, ''))
          ) AS score_categories,
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
          WHERE ${appliedScoresFilter.query}
          GROUP BY
            trace_id,
            observation_id,
            name,
            data_type,
            string_value
        ) tmp
        GROUP BY trace_id, observation_id
      )
      ,
      trace_root AS (
        SELECT
          trace_id,
          project_id,
          name AS trace_name,
          tags,
          start_time AS trace_timestamp,
          user_id
        FROM (
          SELECT
            trace_id,
            project_id,
            trace_name AS name,
            tags,
            start_time,
            user_id,
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
        o.span_id AS id,
        o.type AS type,
        o.project_id AS project_id,
        o.name AS name,
        o.model_parameters AS model_parameters,
        o.start_time AS start_time,
        o.end_time AS end_time,
        o.trace_id AS trace_id,
        o.completion_start_time AS completion_start_time,
        o.provided_usage_details AS provided_usage_details,
        o.usage_details AS usage_details,
        o.provided_cost_details AS provided_cost_details,
        o.cost_details AS cost_details,
        o.level AS level,
        o.environment AS environment,
        o.status_message AS status_message,
        o.version AS version,
        o.parent_span_id AS parent_observation_id,
        o.created_at AS created_at,
        o.updated_at AS updated_at,
        o.provided_model_name AS provided_model_name,
        o.total_cost AS total_cost,
        o.prompt_id AS prompt_id,
        o.prompt_name AS prompt_name,
        o.prompt_version AS prompt_version,
        o.model_id AS internal_model_id,
        o.input AS input,
        o.output AS output,
        o.metadata_names AS metadata_names,
        o.metadata_values AS metadata_values,
        t.trace_name AS traceName,
        t.tags AS traceTags,
        t.trace_timestamp AS traceTimestamp,
        t.user_id AS userId,
        s.scores_avg AS scores_avg,
        s.score_categories AS score_categories
      FROM events_full o
        LEFT JOIN trace_root t
          ON t.trace_id = o.trace_id AND t.project_id = o.project_id
        LEFT JOIN scores_agg s
          ON s.trace_id = o.trace_id AND s.observation_id = o.span_id
      WHERE ${appliedObservationsFilter.query}
        -- observation rows only; the synthetic-trace-row filter from the
        -- legacy schema is replaced by parent_span_id != '' (root span
        -- carries no observation semantics).
        AND o.parent_span_id != ''
        ${search.query}
      ORDER BY o.start_time DESC
      LIMIT {rowLimit: Int64}
  `;

  const asyncGenerator = queryDorisStream<
    ObservationRecordReadType & {
      scores_avg: string | undefined;
      score_categories: string | undefined;
      score_categories_tuples: string | undefined;
    } & {
      traceName: string;
      traceTags: string[];
      traceTimestamp: Date;
      userId: string | null;
    }
  >({
    query,
    params: {
      projectId,
      rowLimit,
      ...appliedScoresFilter.params,
      ...appliedObservationsFilter.params,
      ...search.params,
    },
    tags: {
      feature: "batch-export",
      type: "observation",
      kind: "export",
      projectId,
    },
  });

  // Helper function to process a single observation row
  const modelCache = createModelCache(projectId);
  const emptyScoreColumns = distinctScoreNames.reduce(
    (acc, name) => ({ ...acc, [name]: null }),
    {} as Record<string, null>,
  );

  type ObservationRow = ObservationRecordReadType & {
    scores_avg: string | undefined;
    score_categories: string | undefined;
    score_categories_tuples: string | undefined;
  } & {
    traceName: string;
    traceTags: string[];
    traceTimestamp: Date;
    userId: string | null;
  };

  const processObservationRow = async (
    bufferedRow: ObservationRow,
    commentsByObservation: Map<string, any[]>,
  ) => {
    // Fetch model data from cache (or database if not cached)
    const model = await modelCache.getModel(bufferedRow.internal_model_id);
    const modelData = enrichObservationWithModelData(model);

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

    // Get comments for this observation
    const observationComments = commentsByObservation.get(bufferedRow.id) ?? [];

    return getChunkWithFlattenedScores(
      [
        {
          ...convertObservation(bufferedRow, {
            truncated: false,
            shouldJsonParse: props.fileFormat !== BatchExportFileFormat.CSV,
          }),
          traceName: bufferedRow.traceName,
          traceTags: bufferedRow.traceTags,
          traceTimestamp: bufferedRow.traceTimestamp,
          userId: bufferedRow.userId,
          toolDefinitionsCount: null,
          toolCallsCount: null,
          ...modelData,
          scores: outputScores,
          comments: observationComments,
        },
      ],
      emptyScoreColumns,
    )[0];
  };

  // Convert async generator to Node.js Readable stream

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Counter for potential future instrumentation
  let recordsProcessed = 0;

  return Readable.from(
    (async function* () {
      let rowBuffer: ObservationRow[] = [];
      let observationIds: string[] = [];

      for await (const row of asyncGenerator) {
        rowBuffer.push(row);
        observationIds.push(row.id);

        // Process in batches
        if (rowBuffer.length >= batchSize) {
          // Fetch comments for this batch
          const commentsByObservation = await fetchCommentsForExport(
            projectId,
            "OBSERVATION",
            observationIds,
          );

          // Process each row in the buffer
          for (const bufferedRow of rowBuffer) {
            recordsProcessed++;

            yield await processObservationRow(
              bufferedRow,
              commentsByObservation,
            );
          }

          // Reset buffers
          rowBuffer = [];
          observationIds = [];
        }
      }

      // Process remaining rows in buffer
      if (rowBuffer.length > 0) {
        const commentsByObservation = await fetchCommentsForExport(
          projectId,
          "OBSERVATION",
          observationIds,
        );

        for (const bufferedRow of rowBuffer) {
          recordsProcessed++;
          yield await processObservationRow(bufferedRow, commentsByObservation);
        }
      }
    })(),
  );
};
