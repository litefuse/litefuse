import { beforeEach, describe, expect, it, vi } from "vitest";

const capturedQuery = vi.hoisted(() => ({
  query: "",
  params: {} as Record<string, unknown>,
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();

  return {
    ...actual,
    getDistinctScoreNames: vi.fn().mockResolvedValue([]),
    queryDorisStream: vi.fn((args: { query: string; params: unknown }) => {
      capturedQuery.query = args.query;
      capturedQuery.params = (args.params ?? {}) as Record<string, unknown>;

      return (async function* () {})();
    }),
  };
});

import { getTraceStream } from "../features/database-read-stream/trace-stream";

describe("getTraceStream query generation", () => {
  beforeEach(() => {
    capturedQuery.query = "";
    capturedQuery.params = {};
  });

  it("uses Doris trace columns and aliases for export filters", async () => {
    await getTraceStream({
      projectId: "project-1",
      cutoffCreatedAt: new Date("2026-07-14T03:01:36.029Z"),
      filter: [
        {
          type: "stringOptions",
          column: "environment",
          operator: "none of",
          value: [
            "langfuse-prompt-experiment",
            "langfuse-llm-as-a-judge",
            "langfuse-evaluation",
            "sdk-experiment",
          ],
        },
        {
          type: "datetime",
          column: "timestamp",
          operator: ">=",
          value: new Date("2026-06-14T03:01:24.028Z"),
        },
        {
          type: "datetime",
          column: "timestamp",
          operator: "<=",
          value: new Date("2026-07-14T03:01:24.028Z"),
        },
        {
          type: "stringOptions",
          column: "Trace ID",
          operator: "any of",
          value: ["trace-1"],
        },
      ],
      searchQuery: "findable-trace",
      searchType: ["id"],
    });

    expect(capturedQuery.query).toContain("FROM events_full t");
    expect(capturedQuery.query).toContain("t.environment NOT IN");
    expect(capturedQuery.query).toContain("t.start_time >=");
    expect(capturedQuery.query).toContain("t.start_time <=");
    expect(capturedQuery.query).toContain("t.start_time <");
    expect(capturedQuery.query).toContain("t.trace_id IN ('trace-1')");
    expect(capturedQuery.query).toContain(
      "t.trace_id LIKE {searchQuery: String}",
    );
    expect(capturedQuery.query).not.toContain("t.timestamp");
    expect(capturedQuery.query).not.toContain(" id IN ('trace-1')");
  });
});
