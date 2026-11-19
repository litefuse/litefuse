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

import { getObservationStream } from "../features/database-read-stream/observation-stream";

describe("getObservationStream query generation", () => {
  beforeEach(() => {
    capturedQuery.query = "";
    capturedQuery.params = {};
  });

  it("uses Doris observation columns and aliases for export filters", async () => {
    await getObservationStream({
      projectId: "project1",
      cutoffCreatedAt: new Date("2026-07-14T03:01:36.029Z"),
      filter: [
        {
          type: "stringOptions",
          column: "environment",
          operator: "none of",
          value: ["langfuse-llm-as-a-judge", "sdk-experiment"],
        },
        {
          type: "datetime",
          column: "startTime",
          operator: ">=",
          value: new Date("2026-06-14T03:01:24.028Z"),
        },
        // The predicate a batch action adds for the rows the user ticked. It
        // used to be emitted as o.`id`, a column that does not exist on spans,
        // and every such job died on "Unknown column 'id' in 'o'".
        {
          type: "stringOptions",
          column: "id",
          operator: "any of",
          value: ["63bb6f8cb345bf14"],
        },
      ],
    });

    expect(capturedQuery.query).toContain("FROM spans_project1 o");
    expect(capturedQuery.query).toContain("o.environment NOT IN");
    expect(capturedQuery.query).toContain("o.start_time >=");
    expect(capturedQuery.query).toContain("o.start_time <");
    expect(capturedQuery.query).toContain(
      "o.span_id IN ('63bb6f8cb345bf14')",
    );
    expect(capturedQuery.query).not.toContain("o.`id` IN");
  });
});
