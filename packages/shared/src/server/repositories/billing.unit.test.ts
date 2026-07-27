import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryDorisMock } = vi.hoisted(() => ({
  queryDorisMock: vi.fn(),
}));

vi.mock("./doris", () => ({
  queryDoris: queryDorisMock,
}));

import { getBillingUnitCountsByProjectAndDay } from "./billing";

describe("getBillingUnitCountsByProjectAndDay", () => {
  beforeEach(() => {
    queryDorisMock.mockReset();
  });

  it("does not count root spans as observations", async () => {
    queryDorisMock
      .mockResolvedValueOnce([
        {
          project_id: "project-1",
          date: "2026-07-24",
          traces: "1",
          observations: "1",
        },
      ])
      .mockResolvedValueOnce([
        {
          project_id: "project-1",
          date: "2026-07-24",
          scores: "1",
        },
      ]);

    await expect(
      getBillingUnitCountsByProjectAndDay({
        start: new Date("2026-07-24T00:00:00.000Z"),
        end: new Date("2026-07-25T00:00:00.000Z"),
      }),
    ).resolves.toEqual([
      {
        projectId: "project-1",
        date: "2026-07-24",
        traces: 1,
        observations: 1,
        scores: 1,
        total: 3,
      },
    ]);

    expect(queryDorisMock.mock.calls[0][0].query).toContain(
      "SUM(CASE WHEN parent_span_id != '' THEN 1 ELSE 0 END) AS observations",
    );
  });
});
