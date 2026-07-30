/** @jest-environment node */

import { applyDataAccessLimit } from "./dataAccess";

describe("applyDataAccessLimit", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");

  it("adds a server-enforced lower timestamp bound", () => {
    const filter = [
      {
        column: "timestamp",
        type: "datetime" as const,
        operator: ">=" as const,
        value: new Date("2026-05-01T00:00:00.000Z"),
      },
    ];

    expect(
      applyDataAccessLimit({
        filter,
        dataAccessDays: 30,
        timestampColumn: "timestamp",
        now,
      }),
    ).toEqual([
      ...filter,
      {
        column: "timestamp",
        type: "datetime",
        operator: ">=",
        value: new Date("2026-06-30T12:00:00.000Z"),
      },
    ]);
  });

  it("does not change filters for unlimited access", () => {
    const filter = [
      {
        column: "name",
        type: "string" as const,
        operator: "=" as const,
        value: "test",
      },
    ];

    expect(
      applyDataAccessLimit({
        filter,
        dataAccessDays: false,
        timestampColumn: "timestamp",
        now,
      }),
    ).toBe(filter);
  });
});
