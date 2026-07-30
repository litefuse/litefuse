/**
 * @jest-environment node
 */

import {
  clampTableTimeRangeToLookbackLimit,
  formatDateRange,
} from "@/src/utils/date-range-utils";

describe("formatDateRange", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-03-20T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("formats serialized date values without throwing", () => {
    const formatted = formatDateRange(
      "2026-03-01T00:00:00" as unknown as Date,
      "2026-03-07T23:59:59" as unknown as Date,
    );

    expect(formatted).toBe("Mar 01 - Mar 07");
  });
});

describe("clampTableTimeRangeToLookbackLimit", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");

  it("clamps an unavailable preset to the largest available table range", () => {
    expect(
      clampTableTimeRangeToLookbackLimit({ range: "last90Days" }, 30, now),
    ).toEqual({ range: "last30Days" });
  });

  it("clamps a custom range to the access cutoff", () => {
    expect(
      clampTableTimeRangeToLookbackLimit(
        {
          from: new Date("2026-06-01T00:00:00.000Z"),
          to: now,
        },
        30,
        now,
      ),
    ).toEqual({
      from: new Date("2026-06-30T12:00:00.000Z"),
      to: now,
    });
  });

  it("does not clamp unlimited access", () => {
    const timeRange = { range: "last90Days" };

    expect(clampTableTimeRangeToLookbackLimit(timeRange, false, now)).toBe(
      timeRange,
    );
  });
});
