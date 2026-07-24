import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryDorisMock } = vi.hoisted(() => ({
  queryDorisMock: vi.fn(),
}));

vi.mock("./doris", () => ({
  queryDoris: queryDorisMock,
}));

import {
  getObservationCountOfProjectsSinceCreationDate,
  getObservationCountsByProjectInCreationInterval,
} from "./observations";

describe("billing observation counts", () => {
  beforeEach(() => {
    queryDorisMock.mockReset();
  });

  it("excludes root spans from interval counts", async () => {
    queryDorisMock.mockResolvedValueOnce([
      { project_id: "project-1", count: "1" },
    ]);

    await getObservationCountsByProjectInCreationInterval({
      start: new Date("2026-07-24T00:00:00.000Z"),
      end: new Date("2026-07-24T01:00:00.000Z"),
    });

    expect(queryDorisMock.mock.calls[0][0].query).toContain(
      "parent_span_id != ''",
    );
  });

  it("excludes root spans from billing-cycle counts", async () => {
    queryDorisMock.mockResolvedValueOnce([{ count: "1" }]);

    await getObservationCountOfProjectsSinceCreationDate({
      projectIds: ["project-1"],
      start: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(queryDorisMock.mock.calls[0][0].query).toContain(
      "parent_span_id != ''",
    );
  });
});
