import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "@/src/env.mjs";
import {
  BatchExportQuerySchema,
  BatchExportTableName,
  exportOptions,
  type BatchExportFileFormat,
  type BatchExportQueryType,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  applyCommentFilters,
  getDatasetItemsCount,
  getDatasetRunItemsCountCh,
  getObservationsCountFromEventsTable,
  getObservationsTableCount,
  getObservationsTableLargeFieldStats,
  getPublicSessionsFilter,
  getScoresUiCount,
  getSessionsTableCount,
  getTracesTableCount,
  getTracesTableLargeFieldStats,
  streamTransformations,
  type CommentObjectType,
} from "@langfuse/shared/src/server";
import { getDatabaseReadStreamPaginated } from "./export-stream/getDatabaseReadStream";
import { getObservationStream } from "./export-stream/observation-stream";
import { getTraceStream } from "./export-stream/trace-stream";
import { getEventsStream } from "./export-stream/event-stream";
import { buildBatchExportFileName } from "./batchExportFileName";

const tableToCommentType: Record<string, CommentObjectType | undefined> = {
  traces: "TRACE",
  observations: "OBSERVATION",
  sessions: "SESSION",
};

export const BATCH_EXPORT_BROWSER_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const BATCH_EXPORT_ESTIMATE_SAMPLE_ROWS = 500;
const BATCH_EXPORT_ESTIMATE_SAFETY_FACTOR = 1.1;
const BATCH_EXPORT_LARGE_FIELD_KEYS = ["input", "output", "metadata"] as const;

// Count helpers below consume UI filter identifiers, not raw Doris column names.
const tableToCountCutoffFilterColumnId: Record<string, string> = {
  scores: "timestamp",
  sessions: "createdAt",
  traces: "timestamp",
  observations: "startTime",
  events: "startTime",
  dataset_run_items: "createdAt",
  dataset_items: "createdAt",
  audit_logs: "created_at",
};

export class BatchExportBrowserLimitExceededError extends Error {
  constructor(public readonly measuredBytes: number) {
    super("Batch export exceeds browser download limit");
    this.name = "BatchExportBrowserLimitExceededError";
  }
}

const resolveProcessedFilter = async (
  projectId: string,
  parsedQuery: BatchExportQueryType,
) => {
  const commentObjectType = tableToCommentType[parsedQuery.tableName];
  let processedFilter = parsedQuery.filter ?? [];

  if (!commentObjectType) {
    return processedFilter;
  }

  const { filterState, hasNoMatches } = await applyCommentFilters({
    filterState: parsedQuery.filter ?? [],
    prisma,
    projectId,
    objectType: commentObjectType,
  });

  if (hasNoMatches) {
    return [
      {
        type: "stringOptions" as const,
        operator: "any of" as const,
        column: "id",
        value: [],
      },
    ];
  }

  processedFilter = filterState;
  return processedFilter;
};

const createBatchExportReadStream = async ({
  projectId,
  cutoffCreatedAt,
  parsedQuery,
  processedFilter,
  format,
  rowLimit,
}: {
  projectId: string;
  cutoffCreatedAt: Date;
  parsedQuery: BatchExportQueryType;
  processedFilter: BatchExportQueryType["filter"];
  format: BatchExportFileFormat;
  rowLimit?: number;
}): Promise<Readable> => {
  if (parsedQuery.tableName === BatchExportTableName.Observations) {
    return getObservationStream({
      projectId,
      cutoffCreatedAt,
      ...parsedQuery,
      filter: processedFilter,
      fileFormat: format,
      rowLimit,
    });
  }

  if (parsedQuery.tableName === BatchExportTableName.Traces) {
    return getTraceStream({
      projectId,
      cutoffCreatedAt,
      ...parsedQuery,
      filter: processedFilter,
      rowLimit,
    });
  }

  if (parsedQuery.tableName === BatchExportTableName.Events) {
    return getEventsStream({
      projectId,
      cutoffCreatedAt,
      ...parsedQuery,
      filter: processedFilter,
      rowLimit,
    });
  }

  return getDatabaseReadStreamPaginated({
    projectId,
    cutoffCreatedAt,
    ...parsedQuery,
    filter: processedFilter,
    rowLimit,
  });
};

const createTransformedExportStream = async ({
  projectId,
  query,
  format,
  cutoffCreatedAt,
  rowLimit,
  queryOverride,
}: {
  projectId: string;
  query: unknown;
  format: BatchExportFileFormat;
  cutoffCreatedAt: Date;
  rowLimit?: number;
  queryOverride?: Partial<BatchExportQueryType>;
}) => {
  const parsedQuery = {
    ...BatchExportQuerySchema.parse(query),
    ...queryOverride,
  };
  const processedFilter = await resolveProcessedFilter(projectId, parsedQuery);
  const dbReadStream = await createBatchExportReadStream({
    projectId,
    cutoffCreatedAt,
    parsedQuery,
    processedFilter,
    format,
    rowLimit,
  });

  return dbReadStream.pipe(streamTransformations[format]());
};

const readRowsFromStream = async (stream: Readable) => {
  const rows: unknown[] = [];

  for await (const row of stream) {
    rows.push(row);
  }

  return rows;
};

const serializeRowsAndMeasureBytes = async ({
  rows,
  format,
  byteLimit = BATCH_EXPORT_BROWSER_DOWNLOAD_MAX_BYTES,
}: {
  rows: unknown[];
  format: BatchExportFileFormat;
  byteLimit?: number;
}) => {
  const stream = Readable.from(rows);
  const transformedStream = stream.pipe(streamTransformations[format]());

  return measureStreamBytes({
    stream: transformedStream,
    byteLimit,
  });
};

const stripLargeFieldsFromRow = (row: unknown) => {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }

  const strippedRow = { ...(row as Record<string, unknown>) };

  for (const key of BATCH_EXPORT_LARGE_FIELD_KEYS) {
    if (key in strippedRow) {
      strippedRow[key] = null;
    }
  }

  return strippedRow;
};

const createCountCutoffFilter = (
  tableName: BatchExportQueryType["tableName"],
  cutoffCreatedAt: Date,
) => ({
  column: tableToCountCutoffFilterColumnId[tableName],
  operator: "<" as const,
  value: cutoffCreatedAt,
  type: "datetime" as const,
});

const countBatchExportRows = async ({
  projectId,
  parsedQuery,
  processedFilter,
  cutoffCreatedAt,
}: {
  projectId: string;
  parsedQuery: BatchExportQueryType;
  processedFilter: BatchExportQueryType["filter"];
  cutoffCreatedAt: Date;
}) => {
  const filterWithCutoff = [
    ...(processedFilter ?? []),
    createCountCutoffFilter(parsedQuery.tableName, cutoffCreatedAt),
  ];

  switch (parsedQuery.tableName) {
    case BatchExportTableName.Traces:
      return getTracesTableCount({
        projectId,
        filter: filterWithCutoff,
        searchQuery: parsedQuery.searchQuery ?? undefined,
        searchType: parsedQuery.searchType ?? ["id"],
      });
    case BatchExportTableName.Observations:
      return getObservationsTableCount({
        projectId,
        filter: filterWithCutoff,
        searchQuery: parsedQuery.searchQuery ?? undefined,
        searchType: parsedQuery.searchType ?? ["id"],
      });
    case BatchExportTableName.Events:
      return getObservationsCountFromEventsTable({
        projectId,
        filter: filterWithCutoff,
        searchQuery: parsedQuery.searchQuery ?? undefined,
        searchType: parsedQuery.searchType,
      });
    case BatchExportTableName.Sessions: {
      const publicFilter = await getPublicSessionsFilter(
        projectId,
        filterWithCutoff,
      );
      return getSessionsTableCount({
        projectId,
        filter: publicFilter,
      });
    }
    case BatchExportTableName.Scores:
      return getScoresUiCount({
        projectId,
        filter: filterWithCutoff,
      });
    case BatchExportTableName.DatasetRunItems:
      return getDatasetRunItemsCountCh({
        projectId,
        filter: filterWithCutoff,
      });
    case BatchExportTableName.DatasetItems:
      return getDatasetItemsCount({
        projectId,
        filterState: filterWithCutoff,
        searchQuery: parsedQuery.searchQuery ?? undefined,
      });
    case BatchExportTableName.AuditLogs:
      return prisma.auditLog.count({
        where: {
          projectId,
          createdAt: { lt: cutoffCreatedAt },
        },
      });
    default:
      return env.BATCH_EXPORT_ROW_LIMIT;
  }
};

const getBatchExportLargeFieldStats = async ({
  projectId,
  parsedQuery,
  processedFilter,
  cutoffCreatedAt,
}: {
  projectId: string;
  parsedQuery: BatchExportQueryType;
  processedFilter: BatchExportQueryType["filter"];
  cutoffCreatedAt: Date;
}) => {
  const filterWithCutoff = [
    ...(processedFilter ?? []),
    createCountCutoffFilter(parsedQuery.tableName, cutoffCreatedAt),
  ];

  switch (parsedQuery.tableName) {
    case BatchExportTableName.Traces:
      return getTracesTableLargeFieldStats({
        projectId,
        filter: filterWithCutoff,
        searchQuery: parsedQuery.searchQuery ?? undefined,
        searchType: parsedQuery.searchType ?? ["id"],
      });
    case BatchExportTableName.Observations:
      return getObservationsTableLargeFieldStats({
        projectId,
        filter: filterWithCutoff,
        searchQuery: parsedQuery.searchQuery ?? undefined,
        searchType: parsedQuery.searchType ?? ["id"],
      });
    default:
      return null;
  }
};

const measureStreamBytes = async ({
  stream,
  byteLimit = BATCH_EXPORT_BROWSER_DOWNLOAD_MAX_BYTES,
}: {
  stream: Readable;
  byteLimit?: number;
}) => {
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      const chunkBytes =
        typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk.length
            : Buffer.byteLength(String(chunk));

      bytes += chunkBytes;

      if (bytes > byteLimit) {
        callback(new BatchExportBrowserLimitExceededError(bytes));
        return;
      }

      callback();
    },
  });

  await pipeline(stream, sink);
  return bytes;
};

export const createBatchExportFileStream = async ({
  projectId,
  query,
  format,
  cutoffCreatedAt,
  fileBaseName,
}: {
  projectId: string;
  query: unknown;
  format: BatchExportFileFormat;
  cutoffCreatedAt: Date;
  fileBaseName: string;
}) => {
  const stream = await createTransformedExportStream({
    projectId,
    query,
    format,
    cutoffCreatedAt,
  });

  return {
    stream,
    fileName: buildBatchExportFileName(fileBaseName, format),
    fileType: exportOptions[format].fileType,
  };
};

export const estimateBatchExportSize = async ({
  projectId,
  query,
  format,
  cutoffCreatedAt,
}: {
  projectId: string;
  query: unknown;
  format: BatchExportFileFormat;
  cutoffCreatedAt: Date;
}) => {
  const parsedQuery = BatchExportQuerySchema.parse(query);
  const processedFilter = await resolveProcessedFilter(projectId, parsedQuery);
  const totalRowCount = await countBatchExportRows({
    projectId,
    parsedQuery,
    processedFilter,
    cutoffCreatedAt,
  });

  const cappedRowCount = Math.min(
    totalRowCount,
    parsedQuery.limit ?? totalRowCount,
    env.BATCH_EXPORT_ROW_LIMIT,
  );

  if (cappedRowCount === 0) {
    return {
      estimatedFileSizeBytes: 0,
      exceedsBrowserDownloadLimit: false,
    };
  }

  const sampledRowCount = Math.min(
    cappedRowCount,
    BATCH_EXPORT_ESTIMATE_SAMPLE_ROWS,
  );

  const sampleStream = await createBatchExportReadStream({
    projectId,
    cutoffCreatedAt,
    parsedQuery,
    processedFilter,
    format,
    rowLimit: sampledRowCount,
  });

  const sampledRows = await readRowsFromStream(sampleStream);

  if (sampledRows.length === 0) {
    return {
      estimatedFileSizeBytes: 0,
      exceedsBrowserDownloadLimit: false,
    };
  }

  try {
    const sampledBytes = await serializeRowsAndMeasureBytes({
      rows: sampledRows,
      format,
    });

    if (sampledRows.length >= cappedRowCount) {
      return {
        estimatedFileSizeBytes: sampledBytes,
        exceedsBrowserDownloadLimit:
          sampledBytes > BATCH_EXPORT_BROWSER_DOWNLOAD_MAX_BYTES,
      };
    }

    const largeFieldStats = await getBatchExportLargeFieldStats({
      projectId,
      parsedQuery,
      processedFilter,
      cutoffCreatedAt,
    });

    if (largeFieldStats) {
      const sampledRowsWithoutLargeFields = sampledRows.map(
        stripLargeFieldsFromRow,
      );
      const sampledBaseBytes = await serializeRowsAndMeasureBytes({
        rows: sampledRowsWithoutLargeFields,
        format,
      });
      const averageBaseBytesPerRow = sampledBaseBytes / sampledRows.length;
      const averageLargeFieldBytesPerRow =
        largeFieldStats.avgInputBytes +
        largeFieldStats.avgOutputBytes +
        largeFieldStats.avgMetadataBytes;
      const estimatedFileSizeBytes = Math.ceil(
        (averageBaseBytesPerRow + averageLargeFieldBytesPerRow) *
          cappedRowCount *
          BATCH_EXPORT_ESTIMATE_SAFETY_FACTOR,
      );

      return {
        estimatedFileSizeBytes,
        exceedsBrowserDownloadLimit:
          estimatedFileSizeBytes > BATCH_EXPORT_BROWSER_DOWNLOAD_MAX_BYTES,
      };
    }

    const averageBytesPerRow = sampledBytes / sampledRows.length;
    const estimatedFileSizeBytes = Math.ceil(
      averageBytesPerRow * cappedRowCount * BATCH_EXPORT_ESTIMATE_SAFETY_FACTOR,
    );

    return {
      estimatedFileSizeBytes,
      exceedsBrowserDownloadLimit:
        estimatedFileSizeBytes > BATCH_EXPORT_BROWSER_DOWNLOAD_MAX_BYTES,
    };
  } catch (error) {
    if (error instanceof BatchExportBrowserLimitExceededError) {
      const largeFieldStats = await getBatchExportLargeFieldStats({
        projectId,
        parsedQuery,
        processedFilter,
        cutoffCreatedAt,
      });

      if (largeFieldStats) {
        const sampledRowsWithoutLargeFields = sampledRows.map(
          stripLargeFieldsFromRow,
        );
        const sampledBaseBytes = await serializeRowsAndMeasureBytes({
          rows: sampledRowsWithoutLargeFields,
          format,
          byteLimit: Number.MAX_SAFE_INTEGER,
        });
        const averageBaseBytesPerRow = sampledBaseBytes / sampledRows.length;
        const averageLargeFieldBytesPerRow =
          largeFieldStats.avgInputBytes +
          largeFieldStats.avgOutputBytes +
          largeFieldStats.avgMetadataBytes;
        const estimatedFileSizeBytes = Math.max(
          error.measuredBytes,
          Math.ceil(
            (averageBaseBytesPerRow + averageLargeFieldBytesPerRow) *
              cappedRowCount *
              BATCH_EXPORT_ESTIMATE_SAFETY_FACTOR,
          ),
        );

        return {
          estimatedFileSizeBytes,
          exceedsBrowserDownloadLimit: true,
        };
      }

      return {
        estimatedFileSizeBytes:
          sampledRows.length >= cappedRowCount
            ? error.measuredBytes
            : Math.ceil(
                (error.measuredBytes / sampledRows.length) *
                  cappedRowCount *
                  BATCH_EXPORT_ESTIMATE_SAFETY_FACTOR,
              ),
        exceedsBrowserDownloadLimit: true,
      };
    }

    throw error;
  }
};
