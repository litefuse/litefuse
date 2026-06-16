import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/doris", () => ({
  queryDoris: vi.fn(),
  parseDorisUTCDateTimeFormat: vi.fn((value: string) => new Date(value)),
}));

import { queryDoris } from "../repositories/doris";
import {
  getTracesTable,
  getTracesTableMetrics,
} from "./traces-ui-table-service";

const mockQueryDoris = vi.mocked(queryDoris);

const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("traces ui table queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts root generations in metrics without excluding parent_span_id=''", async () => {
    mockQueryDoris.mockResolvedValueOnce([
      {
        id: "trace_1",
        project_id: "project_1",
        timestamp: new Date("2026-06-10T00:00:00.000Z"),
        level: "DEFAULT",
        observation_count: 1,
        latency: "1",
        usage_details: '{"input":100,"output":50,"total":150}',
        cost_details: '{"input":0.0001,"output":0.0001,"total":0.0002}',
        scores_avg: "[]",
        score_categories: "[]",
        error_count: 0,
        warning_count: 0,
        default_count: 1,
        debug_count: 0,
        public: 0,
      },
    ]);

    const rows = await getTracesTableMetrics({
      projectId: "project_1",
      filter: [
        {
          column: "ID",
          type: "stringOptions",
          operator: "any of",
          value: ["trace_1"],
        },
      ],
      orderBy: { column: "timestamp", order: "DESC" },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.observationCount).toBe(1n);
    expect(rows[0]?.promptTokens).toBe(100n);
    expect(rows[0]?.totalTokens).toBe(150n);
    expect(rows[0]?.calculatedTotalCost?.toNumber()).toBe(0.0002);

    const query = normalizeSql(mockQueryDoris.mock.calls[0]![0].query);
    expect(query).not.toContain(
      "NOT (o.source = 'api' AND o.parent_span_id = '')",
    );
    expect(query).not.toContain("o.parent_span_id != ''");
  });

  it("keeps totalCost filters on direct-write observation aggregates", async () => {
    mockQueryDoris.mockResolvedValueOnce([
      {
        id: "trace_1",
        project_id: "project_1",
        timestamp: new Date("2026-06-10T00:00:00.000Z"),
        tags: [],
        bookmarked: 0,
        name: "trace",
        release: null,
        version: null,
        user_id: null,
        environment: "production",
        session_id: null,
        public: 0,
      },
    ]);

    await getTracesTable({
      projectId: "project_1",
      filter: [
        {
          column: "totalCost",
          type: "number",
          operator: "<=",
          value: 0.000001,
        },
      ],
      orderBy: { column: "timestamp", order: "DESC" },
      limit: 50,
      page: 0,
    });

    const query = normalizeSql(mockQueryDoris.mock.calls[0]![0].query);
    expect(query).toContain("LEFT JOIN observations_stats os");
    expect(query).not.toContain(
      "NOT (o.source = 'api' AND o.parent_span_id = '')",
    );
    expect(query).toContain("<= 0.000001");
    expect(query).not.toContain("o.parent_span_id != ''");
  });
});
