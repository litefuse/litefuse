import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies that client.ts imports
vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    })),
  },
}));
vi.mock("mysql2/promise", () => ({
  default: { createPool: vi.fn() },
  createPool: vi.fn(),
}));
vi.mock("../../../env", () => ({
  env: {
    DORIS_FE_HTTP_URL: "http://localhost:8030",
    DORIS_FE_QUERY_PORT: 9030,
    DORIS_DB: "test",
    DORIS_USER: "root",
    DORIS_PASSWORD: "",
    DORIS_REQUEST_TIMEOUT_MS: 30000,
    DORIS_MAX_OPEN_CONNECTIONS: 10,
    LITEFUSE_ANALYTICS_BACKEND: "doris",
  },
}));
vi.mock("../../instrumentation", () => ({
  getCurrentSpan: vi.fn(),
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

import { formatDataForDoris } from "../client";

describe("formatDataForDoris", () => {
  describe("value normalization", () => {
    it("should convert undefined to null", () => {
      const result = formatDataForDoris([{ name: "test", value: undefined }]);
      expect(result[0].value).toBeNull();
    });

    it("should convert empty array to null", () => {
      const result = formatDataForDoris([{ tags: [] }]);
      expect(result[0].tags).toBeNull();
    });

    it("should keep non-empty array as-is", () => {
      const result = formatDataForDoris([{ tags: ["a", "b"] }]);
      expect(result[0].tags).toEqual(["a", "b"]);
    });

    it("should convert Date objects to ISO string", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      const result = formatDataForDoris([{ created_at: date }]);
      expect(result[0].created_at).toBe("2024-01-15T10:30:00.000Z");
    });

    it("should convert timestamp fields from number to ISO string", () => {
      const ts = new Date("2024-06-15T12:00:00.000Z").getTime();
      const result = formatDataForDoris([{ timestamp: ts }]);
      expect(result[0].timestamp).toBe("2024-06-15T12:00:00.000Z");
    });

    it("should convert timestamp fields from string to ISO string", () => {
      const result = formatDataForDoris([
        { start_time: "2024-06-15T12:00:00.000Z" },
      ]);
      expect(result[0].start_time).toBe("2024-06-15T12:00:00.000Z");
    });

    it("should convert dataset_run_created_at from number epoch to ISO string", () => {
      const ts = new Date("2024-06-15T12:00:00.000Z").getTime();
      const result = formatDataForDoris([{ dataset_run_created_at: ts }]);
      expect(result[0].dataset_run_created_at).toBe("2024-06-15T12:00:00.000Z");
    });

    it("should convert dataset_item_version from number epoch to ISO string", () => {
      const ts = new Date("2024-06-15T12:00:00.000Z").getTime();
      const result = formatDataForDoris([{ dataset_item_version: ts }]);
      expect(result[0].dataset_item_version).toBe("2024-06-15T12:00:00.000Z");
    });

    it("should leave null values as null", () => {
      const result = formatDataForDoris([{ name: null }]);
      expect(result[0].name).toBeNull();
    });

    it("should leave regular strings unchanged", () => {
      const result = formatDataForDoris([{ name: "hello" }]);
      expect(result[0].name).toBe("hello");
    });

    it("should leave regular numbers unchanged", () => {
      const result = formatDataForDoris([{ count: 42 }]);
      expect(result[0].count).toBe(42);
    });
  });

  describe("date field generation for traces table", () => {
    it("should generate timestamp_date from timestamp", () => {
      const result = formatDataForDoris(
        [{ timestamp: "2024-06-15T12:00:00.000Z" }],
        "traces",
      );
      expect((result[0] as any).timestamp_date).toBeDefined();
      expect((result[0] as any).timestamp_date).toBe(
        "2024-06-15T12:00:00.000Z",
      );
    });

    it("should not overwrite existing timestamp_date", () => {
      const result = formatDataForDoris(
        [
          {
            timestamp: "2024-06-15T12:00:00.000Z",
            timestamp_date: "2024-06-14T00:00:00.000Z",
          },
        ],
        "traces",
      );
      expect((result[0] as any).timestamp_date).toBe(
        "2024-06-14T00:00:00.000Z",
      );
    });

    it("should not generate date field when timestamp is null", () => {
      const result = formatDataForDoris([{ timestamp: null }], "traces");
      expect((result[0] as any).timestamp_date).toBeUndefined();
    });
  });

  describe("date field generation for observations table", () => {
    it("should generate start_time_date from start_time", () => {
      const result = formatDataForDoris(
        [{ start_time: "2024-06-15T12:00:00.000Z" }],
        "observations",
      );
      expect((result[0] as any).start_time_date).toBeDefined();
    });
  });

  describe("date field generation for scores table", () => {
    it("should generate timestamp_date from timestamp", () => {
      const result = formatDataForDoris(
        [{ timestamp: "2024-06-15T12:00:00.000Z" }],
        "scores",
      );
      expect((result[0] as any).timestamp_date).toBeDefined();
    });
  });

  describe("unknown table fallback", () => {
    it("should try both timestamp→timestamp_date and start_time→start_time_date", () => {
      const result = formatDataForDoris(
        [
          {
            timestamp: "2024-06-15T12:00:00.000Z",
            start_time: "2024-06-16T12:00:00.000Z",
          },
        ],
        "unknown_table",
      );
      expect((result[0] as any).timestamp_date).toBeDefined();
      expect((result[0] as any).start_time_date).toBeDefined();
    });

    it("should try both date fields when no table name provided", () => {
      const result = formatDataForDoris([
        { timestamp: "2024-06-15T12:00:00.000Z" },
      ]);
      expect((result[0] as any).timestamp_date).toBeDefined();
    });
  });

  describe("metadata normalization for Doris MAP parsing", () => {
    it("should parse JSON object values to native objects (structure preserved)", () => {
      const result = formatDataForDoris([
        {
          id: "test-1",
          metadata: {
            source: "test-script",
            resourceAttributes:
              '{"service.name":"unknown_service:node","host.name":"localhost"}',
            scope: '{"name":"langfuse-sdk","version":"5.2.0"}',
          },
        },
      ]);

      expect(result[0].metadata).toEqual({
        source: "test-script",
        resourceAttributes: {
          "service.name": "unknown_service:node",
          "host.name": "localhost",
        },
        scope: { name: "langfuse-sdk", version: "5.2.0" },
      });
    });

    it("should pass through plain string metadata values unchanged", () => {
      const result = formatDataForDoris([
        {
          id: "test-2",
          metadata: {
            source: "api",
            workflow: "simple-agent",
            versionTag: "v1.0",
          },
        },
      ]);

      expect(result[0].metadata).toEqual({
        source: "api",
        workflow: "simple-agent",
        versionTag: "v1.0",
      });
    });

    it("should parse JSON array values to native arrays", () => {
      const result = formatDataForDoris([
        {
          id: "test-3",
          metadata: {
            availableTools: '["weather_lookup","search"]',
          },
        },
      ]);

      expect(result[0].metadata).toEqual({
        availableTools: ["weather_lookup", "search"],
      });
    });

    it("should handle empty metadata object", () => {
      const result = formatDataForDoris([
        {
          id: "test-4",
          metadata: {},
        },
      ]);

      expect(result[0].metadata).toEqual({});
    });

    it("should preserve null metadata as null", () => {
      const result = formatDataForDoris([
        {
          id: "test-5",
          metadata: null,
        } as any,
      ]);

      expect(result[0].metadata).toBeNull();
    });

    it("should preserve non-JSON string that starts with {", () => {
      const result = formatDataForDoris([
        {
          id: "test-6",
          metadata: {
            broken: "{not valid json!!!}",
          },
        },
      ]);

      expect(result[0].metadata).toEqual({
        broken: "{not valid json!!!}",
      });
    });

    it("should parse empty JSON object value", () => {
      const result = formatDataForDoris([
        {
          id: "test-7",
          metadata: {
            attributes: "{}",
          },
        },
      ]);

      expect(result[0].metadata).toEqual({ attributes: {} });
    });

    it("should handle mixed metadata: some JSON objects, some plain strings, some arrays", () => {
      const result = formatDataForDoris([
        {
          id: "test-8",
          metadata: {
            source: "test",
            resourceAttributes:
              '{"service.name":"unknown_service:node","telemetry.sdk.language":"nodejs"}',
            availableTools: '["tool-a","tool-b"]',
            workflow: "agent",
            scope: '{"name":"langfuse-sdk","version":"5.2.0"}',
          },
        },
      ]);

      expect(result[0].metadata).toEqual({
        source: "test",
        resourceAttributes: {
          "service.name": "unknown_service:node",
          "telemetry.sdk.language": "nodejs",
        },
        availableTools: ["tool-a", "tool-b"],
        workflow: "agent",
        scope: { name: "langfuse-sdk", version: "5.2.0" },
      });
    });

    it("should not affect records without metadata field", () => {
      const result = formatDataForDoris([
        {
          id: "test-9",
          name: "no-metadata-record",
        },
      ]);

      expect(result[0] as any).not.toHaveProperty("metadata");
      expect(result[0].id).toBe("test-9");
    });
  });

  describe("multiple records", () => {
    it("should process all records in the array", () => {
      const result = formatDataForDoris(
        [
          { timestamp: "2024-01-01T00:00:00.000Z", name: "a" },
          { timestamp: "2024-02-01T00:00:00.000Z", name: "b" },
        ],
        "traces",
      );
      expect(result).toHaveLength(2);
      expect((result[0] as any).timestamp_date).toBeDefined();
      expect((result[1] as any).timestamp_date).toBeDefined();
    });
  });
});
