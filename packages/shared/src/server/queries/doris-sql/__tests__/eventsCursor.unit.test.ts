import { describe, expect, it } from "vitest";
import {
  EVENTS_CURSOR_KEYSET_WHERE,
  EVENTS_CURSOR_ORDER_BY,
  eventsCursorKeysetParams,
  type EventsCursor,
} from "../eventsCursor";
import { DorisParameterProcessor } from "../../../doris/parameterProcessor";

const cursor = (overrides: Partial<EventsCursor> = {}): EventsCursor => ({
  lastStartTimeTo: new Date("2026-10-09T02:20:08.149Z"),
  lastTraceId: "0792178d146dd2d28c4d3d1de5c0a444",
  lastId: "01a11e75-f4ac-7ff5-bee9-bc1b522467c0",
  ...overrides,
});

describe("events cursor keyset pagination SQL", () => {
  it("orders by the same triple the keyset predicate advances over", () => {
    // The predicate is only sound if ORDER BY lists exactly the columns the
    // cursor encodes, with the same direction: an omitted tie-breaker lets
    // equal-timestamp rows land on either side of the cursor and duplicate or
    // skip across pages.
    expect(EVENTS_CURSOR_ORDER_BY).toBe(
      "ORDER BY o.start_time DESC, o.trace_id DESC, o.span_id DESC",
    );

    const orderColumns = EVENTS_CURSOR_ORDER_BY.replace("ORDER BY ", "")
      .split(",")
      .map((part) => part.trim().split(" "));

    expect(orderColumns).toEqual([
      ["o.start_time", "DESC"],
      ["o.trace_id", "DESC"],
      ["o.span_id", "DESC"],
    ]);

    // Every ordered column must also appear in the strict comparison, i.e. the
    // predicate walks the same tuple in the same direction.
    for (const [column, direction] of orderColumns) {
      expect(direction).toBe("DESC");
      expect(EVENTS_CURSOR_KEYSET_WHERE).toContain(`${column} < `);
    }
  });

  it("expands the row comparison rather than using a tuple compare", () => {
    // Doris cannot parse `(a, b, c) < (x, y, z)`.
    expect(EVENTS_CURSOR_KEYSET_WHERE).not.toMatch(/\)\s*</);
    expect(EVENTS_CURSOR_KEYSET_WHERE).toContain(
      "o.start_time < {lastStartTime: String}",
    );
    expect(EVENTS_CURSOR_KEYSET_WHERE).toContain(
      "AND o.start_time <= {lastStartTime: String}",
    );
  });

  it("binds every placeholder it references", () => {
    const placeholders = [
      ...new Set(
        [...EVENTS_CURSOR_KEYSET_WHERE.matchAll(/\{(\w+):/g)].map((m) => m[1]),
      ),
    ].sort();

    expect(placeholders).toEqual(["lastId", "lastStartTime", "lastTraceId"]);
    expect(Object.keys(eventsCursorKeysetParams(cursor())).sort()).toEqual(
      placeholders,
    );
  });

  it("renders to executable SQL through the Doris parameter processor", () => {
    const rendered = DorisParameterProcessor.processQuery(
      `SELECT o.span_id FROM spans_p1 o WHERE o.project_id = {projectId: String} ${EVENTS_CURSOR_KEYSET_WHERE}`,
      { projectId: "p1", ...eventsCursorKeysetParams(cursor()) },
    );

    // No placeholder survives, and start_time keeps millisecond precision
    // (the column is DateTime(3), the cursor crossed tRPC as a JS Date).
    expect(rendered).not.toMatch(/\{\w+:/);
    expect(rendered).toContain("o.start_time <= '2026-10-09 02:20:08.149'");
    expect(rendered).toContain(
      "o.trace_id = '0792178d146dd2d28c4d3d1de5c0a444'",
    );
    expect(rendered).toContain(
      "o.span_id < '01a11e75-f4ac-7ff5-bee9-bc1b522467c0'",
    );
  });

  it("escapes cursor values so a cursor cannot inject SQL", () => {
    const rendered = DorisParameterProcessor.processQuery(
      EVENTS_CURSOR_KEYSET_WHERE,
      eventsCursorKeysetParams(
        cursor({ lastId: "x' OR 1=1 --", lastTraceId: "t'--" }),
      ),
    );

    expect(rendered).toContain("o.span_id < 'x'' OR 1=1 --'");
    expect(rendered).toContain("o.trace_id = 't''--'");
  });
});
