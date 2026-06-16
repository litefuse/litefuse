import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  axiosCreate: vi.fn(),
  createPool: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    create: mocks.axiosCreate,
  },
}));

vi.mock("mysql2/promise", () => ({
  default: { createPool: mocks.createPool },
  createPool: mocks.createPool,
}));

vi.mock("../../../env", () => ({
  env: {
    DORIS_FE_HTTP_URL: "http://fe-host:8030",
    DORIS_FE_QUERY_PORT: 9030,
    DORIS_DB: "langfuse",
    DORIS_USER: "root",
    DORIS_PASSWORD: "",
    DORIS_REQUEST_TIMEOUT_MS: 30000,
    DORIS_MAX_OPEN_CONNECTIONS: 100,
    LITEFUSE_INGESTION_DORIS_MAX_ATTEMPTS: 3,
    LITEFUSE_INGESTION_DORIS_HTTP_MAX_SOCKETS: 200,
    LITEFUSE_DORIS_LOG_STREAM_LOAD_RESPONSE: "false",
    LITEFUSE_DORIS_SLOW_QUERY_THRESHOLD_MS: 2000,
  },
}));

vi.mock("../../instrumentation", () => ({
  getCurrentSpan: vi.fn(() => null),
}));

vi.mock("@opentelemetry/api", () => ({
  propagation: { inject: vi.fn() },
  context: { active: vi.fn() },
}));

vi.mock("../../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { DorisClient } from "../client";

describe("DorisClient mysql2 typeCast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.axiosCreate.mockReturnValue({
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    });
    mocks.createPool.mockReturnValue({
      on: vi.fn(),
      query: vi.fn(),
    });
  });

  it("decodes Doris String columns as utf8", () => {
    new DorisClient();

    const poolConfig = mocks.createPool.mock.calls[0]?.[0];
    expect(poolConfig).toBeDefined();

    const field = {
      type: "BLOB",
      string: vi.fn(() => "test-generation🎊"),
    };

    const result = poolConfig.typeCast(field, vi.fn());

    expect(field.string).toHaveBeenCalledWith("utf8");
    expect(result).toBe("test-generation🎊");
  });

  it("parses Doris Variant columns from utf8 JSON", () => {
    new DorisClient();

    const poolConfig = mocks.createPool.mock.calls[0]?.[0];
    expect(poolConfig).toBeDefined();

    const field = {
      name: "output",
      type: "JSON",
      string: vi.fn(() => '[{"content":"Paris.🌹"}]'),
    };

    const result = poolConfig.typeCast(field, vi.fn());

    expect(field.string).toHaveBeenCalledWith("utf8");
    expect(result).toEqual([{ content: "Paris.🌹" }]);
  });
});
