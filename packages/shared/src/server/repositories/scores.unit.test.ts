import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./doris", () => ({
  queryDoris: vi.fn(),
  queryDorisStream: vi.fn(),
  commandDoris: vi.fn(),
  upsertDoris: vi.fn(),
  parseDorisUTCDateTimeFormat: vi.fn(),
}));

import { queryDoris } from "./doris";
import { getScoresUiCount, getScoresUiTable } from "./scores";
import type { FilterState } from "../../types";

const mockQueryDoris = vi.mocked(queryDoris);

const userIdFilter: FilterState = [
  {
    column: "User ID",
    type: "string",
    operator: "=",
    value: "user_1",
  },
];

const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("scores ui queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps trace filters outside the inner score subquery for rows", async () => {
    mockQueryDoris.mockResolvedValueOnce([]);

    await getScoresUiTable({
      projectId: "project_1",
      filter: userIdFilter,
      orderBy: { column: "timestamp", order: "DESC" },
      limit: 50,
      offset: 0,
      excludeMetadata: true,
      includeHasMetadataFlag: true,
    });

    const query = normalizeSql(mockQueryDoris.mock.calls[0][0].query);
    const innerQuery = query.slice(
      query.indexOf("FROM ( SELECT s.*"),
      query.indexOf(") sm LEFT JOIN events_full t"),
    );

    expect(innerQuery).not.toContain("t.user_id");
    expect(query).toContain("LEFT JOIN events_full t");
    expect(query).toContain("t.user_id = 'user_1'");
  });

  it("does not project trace columns in count queries", async () => {
    mockQueryDoris.mockResolvedValueOnce([{ count: "3" }]);

    const count = await getScoresUiCount({
      projectId: "project_1",
      filter: userIdFilter,
      orderBy: null,
      limit: 1,
      offset: 0,
    });

    expect(count).toBe(3);

    const query = normalizeSql(mockQueryDoris.mock.calls[0][0].query);
    expect(query).toContain("SELECT count(*) as count");
    expect(query).not.toContain(
      "t.user_id, t.name as trace_name, t.tags as trace_tags",
    );
    expect(query).toContain("LEFT JOIN events_full t");
    expect(query).toContain("t.user_id = 'user_1'");
  });
});
