import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rowsKey = "LITEFUSE_BLOB_STORAGE_EXPORT_PARQUET_ROW_GROUP_MAX_ROWS";
const bytesKey = "LITEFUSE_BLOB_STORAGE_EXPORT_PARQUET_ROW_GROUP_TARGET_BYTES";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/parquet_config_test");
  vi.stubEnv("LITEFUSE_S3_EVENT_UPLOAD_BUCKET", "parquet-config-test");
  vi.stubEnv("DOCKER_BUILD", undefined);
  vi.stubEnv(rowsKey, undefined);
  vi.stubEnv(bytesKey, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("defaults Parquet row groups to 10,000 rows and 64 MiB", async () => {
  const { env } = await import("../env");
  expect(env).toMatchObject({ [rowsKey]: 10_000, [bytesKey]: 67_108_864 });
});

it("parses custom Parquet row group limits from environment strings", async () => {
  vi.stubEnv(rowsKey, "123");
  vi.stubEnv(bytesKey, "4096");
  const { env } = await import("../env");
  expect(env).toMatchObject({ [rowsKey]: 123, [bytesKey]: 4096 });
});

it.each(
  [rowsKey, bytesKey].flatMap((key) =>
    ["0", "-1", "1.5", "invalid"].map((value) => ({ key, value })),
  ),
)("rejects $key=$value", async ({ key, value }) => {
  vi.stubEnv(key, value);
  await expect(import("../env")).rejects.toThrow(key);
});
