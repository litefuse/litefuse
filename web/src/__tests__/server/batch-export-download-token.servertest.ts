/** @jest-environment node */

import { env } from "@/src/env.mjs";
import {
  createBatchExportDownloadPath,
  createBatchExportDownloadToken,
  verifyBatchExportDownloadToken,
} from "@/src/features/batch-exports/server/batchExportDownloadToken";
import { buildBatchExportFileName } from "@/src/features/batch-exports/server/batchExportFileName";

describe("batch export download token helpers", () => {
  const originalSecret = env.BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET;
  const originalNodeEnv = env.NODE_ENV;

  const payload = {
    batchExportId: "be_123",
    projectId: "project_123",
    expiresAt: "2026-05-20T00:00:00.000Z",
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-19T00:00:00.000Z"));
    env.BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET = "batch-export-test-secret";
  });

  afterEach(() => {
    env.BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET = originalSecret;
    env.NODE_ENV = originalNodeEnv;
    jest.useRealTimers();
  });

  it("round-trips a signed token", () => {
    const token = createBatchExportDownloadToken(payload);

    expect(verifyBatchExportDownloadToken(token)).toEqual({
      ok: true,
      payload,
    });
  });

  it("rejects a tampered token", () => {
    const token = createBatchExportDownloadToken(payload);
    const tampered = `${token}x`;

    expect(verifyBatchExportDownloadToken(tampered)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects an expired token", () => {
    const token = createBatchExportDownloadToken({
      ...payload,
      expiresAt: "2026-05-18T00:00:00.000Z",
    });

    expect(verifyBatchExportDownloadToken(token)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token signed with a different secret", () => {
    const token = createBatchExportDownloadToken(payload);

    env.BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET = "different-secret";

    expect(verifyBatchExportDownloadToken(token)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a token with an invalid payload encoding", () => {
    const token = "not-base64.batch-export-signature";

    expect(verifyBatchExportDownloadToken(token)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("falls back to a SALT-derived secret when no explicit secret is configured", () => {
    env.BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET = undefined;
    env.NODE_ENV = "production";
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const token = createBatchExportDownloadToken(payload);

    expect(verifyBatchExportDownloadToken(token)).toEqual({
      ok: true,
      payload,
    });
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("builds the signed download path", () => {
    const path = createBatchExportDownloadPath("project_123", "signed-token");

    expect(path).toContain(
      "/api/project/project_123/batch-export/download?token=signed-token",
    );
  });

  it("sanitizes and appends the export file extension", () => {
    expect(buildBatchExportFileName(' traces export: "prod" ', "CSV")).toBe(
      "traces export- -prod-.csv",
    );
    expect(buildBatchExportFileName("events.jsonl", "JSONL")).toBe(
      "events.jsonl",
    );
  });
});
