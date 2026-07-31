import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryDorisMock } = vi.hoisted(() => ({
  queryDorisMock: vi.fn(),
}));

vi.mock("./doris", () => ({
  queryDoris: queryDorisMock,
}));

import {
  getBillingUnitCountForProjects,
  getBillingUnitCountsByProjectAndDay,
  getBillingUnitCountsForProjectWindows,
} from "./billing";

describe("getBillingUnitCountsByProjectAndDay", () => {
  beforeEach(() => {
    queryDorisMock.mockReset();
  });

  it("counts root spans as observations and traces", async () => {
    queryDorisMock
      .mockResolvedValueOnce([
        {
          project_id: "project-1",
          date: "2026-07-24",
          traces: "1",
          observations: "2",
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
        observations: 2,
        scores: 1,
        total: 4,
      },
    ]);

    expect(queryDorisMock.mock.calls[0][0].query).toContain(
      "COUNT(*) AS observations",
    );
  });
});

describe("precise billing unit counts", () => {
  beforeEach(() => {
    queryDorisMock.mockReset();
  });

  it("uses the same trace, observation, and score formula for an interval", async () => {
    queryDorisMock
      .mockResolvedValueOnce([{ traces: "1", observations: "2" }])
      .mockResolvedValueOnce([{ scores: "1" }]);

    await expect(
      getBillingUnitCountForProjects({
        projectIds: ["project-1"],
        start: new Date("2026-07-30T10:37:22.456Z"),
        end: new Date("2026-07-30T11:00:00.000Z"),
      }),
    ).resolves.toEqual({
      traces: 1,
      observations: 2,
      scores: 1,
      total: 4,
    });

    expect(queryDorisMock.mock.calls[0][0].params).toMatchObject({
      start: "2026-07-30 10:37:22.456",
      end: "2026-07-30 11:00:00.000",
    });
  });

  it("supports a different exact cycle start for each project", async () => {
    queryDorisMock
      .mockResolvedValueOnce([
        { project_id: "project-1", traces: "1", observations: "2" },
      ])
      .mockResolvedValueOnce([{ project_id: "project-1", scores: "1" }]);

    await expect(
      getBillingUnitCountsForProjectWindows({
        windows: [
          {
            projectId: "project-1",
            start: new Date("2026-07-30T10:37:22.456Z"),
          },
          {
            projectId: "project-2",
            start: new Date("2026-07-29T08:15:00.000Z"),
          },
        ],
        end: new Date("2026-07-30T11:00:00.000Z"),
      }),
    ).resolves.toEqual(
      new Map([
        ["project-1", 4],
        ["project-2", 0],
      ]),
    );

    expect(queryDorisMock.mock.calls[0][0].params).toMatchObject({
      projectId0: "project-1",
      start0: "2026-07-30 10:37:22.456",
      projectId1: "project-2",
      start1: "2026-07-29 08:15:00.000",
    });
  });
});
