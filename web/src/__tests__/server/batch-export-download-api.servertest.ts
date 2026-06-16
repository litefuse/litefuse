/** @jest-environment node */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMocks } from "node-mocks-http";

jest.mock("@langfuse/shared/src/db", () => ({
  __esModule: true,
  prisma: {
    batchExport: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("@langfuse/shared/src/server", () => ({
  __esModule: true,
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock("../../features/batch-exports/server/exportService", () => ({
  __esModule: true,
  createBatchExportFileStream: jest.fn(),
}));

jest.mock(
  "../../features/batch-exports/server/batchExportDownloadToken",
  () => ({
    __esModule: true,
    verifyBatchExportDownloadToken: jest.fn(),
  }),
);

jest.mock("node:stream/promises", () => ({
  __esModule: true,
  pipeline: jest.fn(),
}));

import handler from "@/src/pages/api/project/[projectId]/batch-export/download";
import { prisma } from "@langfuse/shared/src/db";
import { createBatchExportFileStream } from "../../features/batch-exports/server/exportService";
import { verifyBatchExportDownloadToken } from "../../features/batch-exports/server/batchExportDownloadToken";

const mockPipeline = jest.mocked(pipeline);
const mockFindFirst = jest.mocked(prisma.batchExport.findFirst);
const mockUpdate = jest.mocked(prisma.batchExport.update);
const mockCreateBatchExportFileStream = jest.mocked(
  createBatchExportFileStream,
);
const mockVerifyBatchExportDownloadToken = jest.mocked(
  verifyBatchExportDownloadToken,
);

describe("/api/project/[projectId]/batch-export/download", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createRequestResponse = ({
    method = "GET",
    projectId = "project_123",
    token = "signed-token",
  }: {
    method?: string;
    projectId?: string;
    token?: string;
  }) =>
    createMocks({
      method,
      query: {
        projectId,
        token,
      },
    });

  it("returns 401 for an invalid token", async () => {
    mockVerifyBatchExportDownloadToken.mockReturnValue({
      ok: false,
      reason: "invalid",
    });
    const { req, res } = createRequestResponse({});

    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toEqual({ message: "Invalid download token" });
  });

  it("returns 410 for an expired token", async () => {
    mockVerifyBatchExportDownloadToken.mockReturnValue({
      ok: false,
      reason: "expired",
    });
    const { req, res } = createRequestResponse({});

    await handler(req, res);

    expect(res._getStatusCode()).toBe(410);
    expect(res._getJSONData()).toEqual({ message: "Download token expired" });
  });

  it("returns 409 when the export is not ready for download", async () => {
    mockVerifyBatchExportDownloadToken.mockReturnValue({
      ok: true,
      payload: {
        batchExportId: "be_123",
        projectId: "project_123",
        expiresAt: "2026-05-20T00:00:00.000Z",
      },
    });
    mockFindFirst.mockResolvedValue({
      id: "be_123",
      projectId: "project_123",
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      expiresAt: null,
      status: "PROCESSING",
      query: {
        tableName: "traces",
        filter: null,
        orderBy: { column: "timestamp", order: "DESC" },
      },
      format: "CSV",
      name: "traces export",
    });
    const { req, res } = createRequestResponse({});

    await handler(req, res);

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({
      message: "Batch export is not available for download",
    });
  });

  it("returns 403 when the token project does not match the route project", async () => {
    mockVerifyBatchExportDownloadToken.mockReturnValue({
      ok: true,
      payload: {
        batchExportId: "be_123",
        projectId: "project_other",
        expiresAt: "2026-05-20T00:00:00.000Z",
      },
    });
    const { req, res } = createRequestResponse({});

    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({
      message: "Download token project mismatch",
    });
  });

  it("streams a ready batch export", async () => {
    const stream = Readable.from(["csv-data"]);

    mockVerifyBatchExportDownloadToken.mockReturnValue({
      ok: true,
      payload: {
        batchExportId: "be_123",
        projectId: "project_123",
        expiresAt: "2026-05-20T00:00:00.000Z",
      },
    });
    mockFindFirst.mockResolvedValue({
      id: "be_123",
      projectId: "project_123",
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      expiresAt: null,
      status: "READY",
      query: {
        tableName: "traces",
        filter: null,
        orderBy: { column: "timestamp", order: "DESC" },
      },
      format: "CSV",
      name: "traces export",
    });
    mockCreateBatchExportFileStream.mockResolvedValue({
      stream,
      fileName: "traces-export.csv",
      fileType: "text/csv; charset=utf-8",
    });
    mockPipeline.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue({
      id: "be_123",
    } as any);
    const { req, res } = createRequestResponse({});

    await handler(req, res);

    expect(mockCreateBatchExportFileStream).toHaveBeenCalledWith({
      projectId: "project_123",
      query: {
        tableName: "traces",
        filter: null,
        orderBy: { column: "timestamp", order: "DESC" },
      },
      format: "CSV",
      cutoffCreatedAt: new Date("2026-05-19T00:00:00.000Z"),
      fileBaseName: "traces export",
    });
    expect(res.getHeader("Cache-Control")).toBe("no-store");
    expect(res.getHeader("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.getHeader("Content-Disposition")).toBe(
      'attachment; filename="traces-export.csv"',
    );
    expect(mockPipeline).toHaveBeenCalledWith(stream, res);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: {
        id: "be_123",
      },
      data: {
        finishedAt: expect.any(Date),
      },
    });
  });

  it("accepts legacy API_ONLY exports for download", async () => {
    const stream = Readable.from(["json-data"]);

    mockVerifyBatchExportDownloadToken.mockReturnValue({
      ok: true,
      payload: {
        batchExportId: "be_legacy",
        projectId: "project_123",
        expiresAt: "2026-05-20T00:00:00.000Z",
      },
    });
    mockFindFirst.mockResolvedValue({
      id: "be_legacy",
      projectId: "project_123",
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      expiresAt: null,
      status: "API_ONLY",
      query: {
        tableName: "traces",
        filter: null,
        orderBy: { column: "timestamp", order: "DESC" },
      },
      format: "JSON",
      name: "legacy export",
    });
    mockCreateBatchExportFileStream.mockResolvedValue({
      stream,
      fileName: "legacy-export.json",
      fileType: "application/json; charset=utf-8",
    });
    mockPipeline.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue({
      id: "be_legacy",
    } as any);
    const { req, res } = createRequestResponse({});

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockPipeline).toHaveBeenCalledWith(stream, res);
  });
});
