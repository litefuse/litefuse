/**
 * @jest-environment node
 */

import { formatDateRange } from "@/src/utils/date-range-utils";

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
