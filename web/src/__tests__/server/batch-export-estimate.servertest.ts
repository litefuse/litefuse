/** @jest-environment node */

import { Readable } from "node:stream";
import { Transform } from "node:stream";

jest.mock("@langfuse/shared/src/db", () => ({
  __esModule: true,
  prisma: {},
}));

jest.mock("@langfuse/shared/src/server", () => {
  return {
    __esModule: true,
    applyCommentFilters: jest.fn(async ({ filterState }) => ({
      filterState,
      hasNoMatches: false,
    })),
    getDatasetItemsCount: jest.fn(),
    getDatasetRunItemsCountCh: jest.fn(),
    getObservationsCountFromEventsTable: jest.fn(),
    getObservationsTableCount: jest.fn(),
    getObservationsTableLargeFieldStats: jest.fn(),
    getPublicSessionsFilter: jest.fn(),
    getScoresUiCount: jest.fn(),
    getSessionsTableCount: jest.fn(),
    getTracesTableCount: jest.fn(),
    getTracesTableLargeFieldStats: jest.fn(),
    streamTransformations: {
      CSV: () =>
        new Transform({
          objectMode: true,
          transform(row, _encoding, callback) {
            callback(null, JSON.stringify(row) + "\n");
          },
        }),
      JSON: () =>
        new Transform({
          objectMode: true,
          transform(row, _encoding, callback) {
            callback(null, JSON.stringify(row));
          },
        }),
      JSONL: () =>
        new Transform({
          objectMode: true,
          transform(row, _encoding, callback) {
            callback(null, JSON.stringify(row) + "\n");
          },
        }),
    },
  };
});

jest.mock(
  "../../features/batch-exports/server/export-stream/getDatabaseReadStream",
  () => ({
    __esModule: true,
    getDatabaseReadStreamPaginated: jest.fn(),
  }),
);

jest.mock(
  "../../features/batch-exports/server/export-stream/observation-stream",
  () => ({
    __esModule: true,
    getObservationStream: jest.fn(),
  }),
);

jest.mock(
  "../../features/batch-exports/server/export-stream/trace-stream",
  () => ({
    __esModule: true,
    getTraceStream: jest.fn(),
  }),
);

jest.mock(
  "../../features/batch-exports/server/export-stream/event-stream",
  () => ({
    __esModule: true,
    getEventsStream: jest.fn(),
  }),
);

import { BatchExportFileFormat } from "@langfuse/shared";
import {
  applyCommentFilters,
  getObservationsCountFromEventsTable,
  getObservationsTableCount,
  getObservationsTableLargeFieldStats,
  getTracesTableCount,
  getTracesTableLargeFieldStats,
} from "@langfuse/shared/src/server";
import { getEventsStream } from "../../features/batch-exports/server/export-stream/event-stream";
import { getObservationStream } from "../../features/batch-exports/server/export-stream/observation-stream";
import { getTraceStream } from "../../features/batch-exports/server/export-stream/trace-stream";
import { estimateBatchExportSize } from "../../features/batch-exports/server/exportService";

const mockApplyCommentFilters = jest.mocked(applyCommentFilters);
const mockGetObservationsCountFromEventsTable = jest.mocked(
  getObservationsCountFromEventsTable,
);
const mockGetObservationsTableCount = jest.mocked(getObservationsTableCount);
const mockGetObservationsTableLargeFieldStats = jest.mocked(
  getObservationsTableLargeFieldStats,
);
const mockGetTracesTableCount = jest.mocked(getTracesTableCount);
const mockGetTracesTableLargeFieldStats = jest.mocked(
  getTracesTableLargeFieldStats,
);
const mockGetEventsStream = jest.mocked(getEventsStream);
const mockGetObservationStream = jest.mocked(getObservationStream);
const mockGetTraceStream = jest.mocked(getTraceStream);

const toJsonl = (row: unknown) => `${JSON.stringify(row)}\n`;

describe("estimateBatchExportSize", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyCommentFilters.mockImplementation(async ({ filterState }) => ({
      filterState,
      hasNoMatches: false,
    }));
  });

  it("uses startTime as the cutoff column and direct large-field averages when estimating observations", async () => {
    const cutoffCreatedAt = new Date("2026-05-19T14:36:51.753Z");
    const sampledRows = [
      {
        id: "obs_1",
        name: "first",
        input: "small",
        output: "result",
        metadata: { env: "prod" },
      },
      {
        id: "obs_2",
        name: "second",
        input: "tiny",
        output: "done",
        metadata: { env: "staging" },
      },
    ];

    mockGetObservationsTableCount.mockResolvedValue(1_000);
    mockGetObservationsTableLargeFieldStats.mockResolvedValue({
      avgInputBytes: 120,
      avgOutputBytes: 80,
      avgMetadataBytes: 40,
    });
    mockGetObservationStream.mockResolvedValue(
      Readable.from(sampledRows) as any,
    );

    const estimate = await estimateBatchExportSize({
      projectId: "project-1",
      query: {
        tableName: "observations",
        filter: [],
        orderBy: {
          column: "startTime",
          order: "DESC",
        },
      },
      format: BatchExportFileFormat.JSONL,
      cutoffCreatedAt,
    });

    const strippedSampledRows = sampledRows.map((row) => ({
      ...row,
      input: null,
      output: null,
      metadata: null,
    }));
    const baseBytes =
      strippedSampledRows.reduce(
        (sum, row) => sum + Buffer.byteLength(toJsonl(row)),
        0,
      ) / strippedSampledRows.length;
    const expectedEstimatedBytes = Math.ceil(
      (baseBytes + 120 + 80 + 40) * 1_000 * 1.1,
    );

    expect(estimate).toEqual({
      estimatedFileSizeBytes: expectedEstimatedBytes,
      exceedsBrowserDownloadLimit: false,
    });
    expect(mockGetObservationsTableCount).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.arrayContaining([
          expect.objectContaining({
            column: "startTime",
            operator: "<",
            type: "datetime",
            value: cutoffCreatedAt,
          }),
        ]),
      }),
    );
    expect(mockGetObservationsTableCount.mock.calls[0]?.[0]).not.toHaveProperty(
      "orderBy",
    );
    expect(mockGetObservationsTableLargeFieldStats).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.arrayContaining([
          expect.objectContaining({
            column: "startTime",
            operator: "<",
            type: "datetime",
            value: cutoffCreatedAt,
          }),
        ]),
      }),
    );
  });

  it("uses startTime as the cutoff column when counting events", async () => {
    const cutoffCreatedAt = new Date("2026-05-19T14:36:51.753Z");
    const sampledRows = [
      {
        id: "evt_1",
        input: "sample",
      },
    ];

    mockGetObservationsCountFromEventsTable.mockResolvedValue(1);
    mockGetEventsStream.mockResolvedValue(Readable.from(sampledRows) as any);

    const estimate = await estimateBatchExportSize({
      projectId: "project-1",
      query: {
        tableName: "events",
        filter: [],
        orderBy: {
          column: "startTime",
          order: "DESC",
        },
      },
      format: BatchExportFileFormat.JSONL,
      cutoffCreatedAt,
    });

    expect(estimate).toEqual({
      estimatedFileSizeBytes: Buffer.byteLength(toJsonl(sampledRows[0])),
      exceedsBrowserDownloadLimit: false,
    });
    expect(mockGetObservationsCountFromEventsTable).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.arrayContaining([
          expect.objectContaining({
            column: "startTime",
            operator: "<",
            type: "datetime",
            value: cutoffCreatedAt,
          }),
        ]),
      }),
    );
    expect(
      mockGetObservationsCountFromEventsTable.mock.calls[0]?.[0],
    ).not.toHaveProperty("orderBy");
    expect(
      mockGetObservationsCountFromEventsTable.mock.calls[0]?.[0],
    ).not.toHaveProperty("limit");
    expect(
      mockGetObservationsCountFromEventsTable.mock.calls[0]?.[0],
    ).not.toHaveProperty("offset");
  });

  it("uses direct large-field averages when estimating traces", async () => {
    const cutoffCreatedAt = new Date("2026-05-19T14:49:22.000Z");
    const sampledRows = [
      {
        id: "trace_1",
        name: "checkout",
        input: { cartId: "cart-1" },
        output: { status: "ok" },
        metadata: { version: "1" },
      },
      {
        id: "trace_2",
        name: "checkout",
        input: { cartId: "cart-2" },
        output: { status: "ok" },
        metadata: { version: "2" },
      },
    ];

    mockGetTracesTableCount.mockResolvedValue(900);
    mockGetTracesTableLargeFieldStats.mockResolvedValue({
      avgInputBytes: 150,
      avgOutputBytes: 90,
      avgMetadataBytes: 35,
    });
    mockGetTraceStream.mockResolvedValue(Readable.from(sampledRows) as any);

    const estimate = await estimateBatchExportSize({
      projectId: "project-1",
      query: {
        tableName: "traces",
        filter: [],
        orderBy: {
          column: "timestamp",
          order: "DESC",
        },
      },
      format: BatchExportFileFormat.JSONL,
      cutoffCreatedAt,
    });

    const strippedSampledRows = sampledRows.map((row) => ({
      ...row,
      input: null,
      output: null,
      metadata: null,
    }));
    const baseBytes =
      strippedSampledRows.reduce(
        (sum, row) => sum + Buffer.byteLength(toJsonl(row)),
        0,
      ) / strippedSampledRows.length;
    const expectedEstimatedBytes = Math.ceil(
      (baseBytes + 150 + 90 + 35) * 900 * 1.1,
    );

    expect(estimate).toEqual({
      estimatedFileSizeBytes: expectedEstimatedBytes,
      exceedsBrowserDownloadLimit: false,
    });
    expect(mockGetTracesTableCount).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.arrayContaining([
          expect.objectContaining({
            column: "timestamp",
            operator: "<",
            type: "datetime",
            value: cutoffCreatedAt,
          }),
        ]),
      }),
    );
    expect(mockGetTracesTableCount.mock.calls[0]?.[0]).not.toHaveProperty(
      "orderBy",
    );
    expect(mockGetTracesTableLargeFieldStats).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.arrayContaining([
          expect.objectContaining({
            column: "timestamp",
            operator: "<",
            type: "datetime",
            value: cutoffCreatedAt,
          }),
        ]),
      }),
    );
  });
});
