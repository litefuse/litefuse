/** @jest-environment node */

jest.mock("@langfuse/shared/src/server", () => {
  const actual = jest.requireActual("@langfuse/shared/src/server");

  return {
    __esModule: true,
    ...actual,
    getObservationsWithModelDataFromEventsTable: jest.fn(),
    getScoresForObservations: jest.fn(),
    getScoresForTraces: jest.fn(),
    traceException: jest.fn(),
  };
});

import * as sharedServer from "@langfuse/shared/src/server";
import {
  getEventList,
  getEventListCursor,
} from "@/src/features/events/server/eventsService";

const mockList = jest.mocked(
  sharedServer.getObservationsWithModelDataFromEventsTable,
);
const mockScoresForObservations = jest.mocked(
  sharedServer.getScoresForObservations,
);
const mockScoresForTraces = jest.mocked(sharedServer.getScoresForTraces);

type Row = { id: string; traceId: string | null; startTime: Date };

const row = (id: string, startTime: string, traceId = `trace-${id}`): Row => ({
  id,
  traceId,
  startTime: new Date(startTime),
});

// getObservationsWithModelDataFromEventsTable returns enriched observations;
// only id/traceId/startTime matter to the pagination maths under test.
const primeList = (rows: Row[]) => {
  mockList.mockResolvedValueOnce(rows as never);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockScoresForObservations.mockResolvedValue([] as never);
  mockScoresForTraces.mockResolvedValue([] as never);
});

describe("events cursor pagination (eventsService)", () => {
  it("getEventList keeps the offset contract: { observations } only", async () => {
    primeList([row("a", "2026-10-09T02:00:00.000Z")]);

    const result = await getEventList({
      projectId: "p1",
      filter: [],
      searchQuery: "q",
      searchType: ["id"],
      orderBy: { column: "startTime", order: "DESC" },
      page: 3,
      limit: 2,
    });

    expect(Object.keys(result)).toEqual(["observations"]);
    expect(result.observations).toHaveLength(1);

    // No cursor parameters and still the caller's own limit/offset/orderBy.
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      limit: 2,
      offset: 4,
      orderBy: { column: "startTime", order: "DESC" },
    });
    expect(mockList.mock.calls[0][0].cursorPagination).toBeUndefined();
    expect(mockList.mock.calls[0][0].cursor).toBeUndefined();
  });

  it("getEventListCursor asks for limit + 1 rows with cursor pagination and no offset", async () => {
    primeList([row("a", "2026-10-09T02:00:00.000Z")]);

    await getEventListCursor({
      projectId: "p1",
      filter: [],
      searchQuery: undefined,
      searchType: ["id"],
      limit: 10,
    });

    expect(mockList.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      limit: 11,
      cursorPagination: true,
    });
    expect(mockList.mock.calls[0][0].offset).toBeUndefined();
    expect(mockList.mock.calls[0][0].cursor).toBeUndefined();
  });

  it("slices the probe row off and derives nextCursor from the last returned row", async () => {
    primeList([
      row("a", "2026-10-09T02:00:00.000Z"),
      row("b", "2026-10-09T01:00:00.000Z"),
      row("c", "2026-10-09T00:00:00.000Z"), // the limit+1 probe row
    ]);

    const page = await getEventListCursor({
      projectId: "p1",
      filter: [],
      searchType: ["id"],
      limit: 2,
    });

    expect(page.hasMore).toBe(true);
    expect(page.observations.map((o) => o.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toEqual({
      lastStartTimeTo: new Date("2026-10-09T01:00:00.000Z"),
      lastTraceId: "trace-b",
      lastId: "b",
    });
  });

  it("reports the last page without a next cursor", async () => {
    primeList([
      row("a", "2026-10-09T02:00:00.000Z"),
      row("b", "2026-10-09T01:00:00.000Z"),
    ]);

    const page = await getEventListCursor({
      projectId: "p1",
      filter: [],
      searchType: ["id"],
      limit: 2,
    });

    expect(page.hasMore).toBe(false);
    expect(page.observations.map((o) => o.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("returns an empty page for no matches", async () => {
    primeList([]);

    const page = await getEventListCursor({
      projectId: "p1",
      filter: [],
      searchType: ["id"],
      limit: 2,
    });

    expect(page).toEqual({
      observations: [],
      hasMore: false,
      nextCursor: undefined,
    });
  });

  it("passes the incoming cursor straight through to the query", async () => {
    primeList([row("a", "2026-10-09T02:00:00.000Z", null)]);

    const cursor = {
      lastStartTimeTo: new Date("2026-10-09T03:00:00.000Z"),
      lastTraceId: "trace-z",
      lastId: "z",
    };
    const page = await getEventListCursor({
      projectId: "p1",
      filter: [],
      searchType: ["id"],
      limit: 1,
      cursor,
    });

    expect(mockList.mock.calls[0][0].cursor).toEqual(cursor);
    // Only one of the two requested (limit + 1) rows existed → last page.
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it("encodes an empty-string trace id instead of null at a page boundary", async () => {
    primeList([
      row("a", "2026-10-09T02:00:00.000Z", null),
      row("b", "2026-10-09T01:00:00.000Z"),
    ]);

    const page = await getEventListCursor({
      projectId: "p1",
      filter: [],
      searchType: ["id"],
      limit: 1,
    });

    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({
      lastStartTimeTo: new Date("2026-10-09T02:00:00.000Z"),
      lastTraceId: "",
      lastId: "a",
    });
  });
});
