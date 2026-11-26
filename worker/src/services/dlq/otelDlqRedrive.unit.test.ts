import { describe, it, expect } from "vitest";

import { decideOtelRedrive } from "./otelDlqRedrive";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const base = {
  now: 100 * DAY,
  labelKeepMs: 3 * DAY,
  maxRedrives: 5,
};

describe("decideOtelRedrive (age guard × redrive budget)", () => {
  it("fresh failure → redrive with incremented counter", () => {
    expect(
      decideOtelRedrive({
        ...base,
        firstSeenTs: base.now - HOUR,
        redrivesSoFar: 0,
      }),
    ).toEqual({ action: "redrive", redrives: 1 });
    expect(
      decideOtelRedrive({
        ...base,
        firstSeenTs: base.now - HOUR,
        redrivesSoFar: 4,
      }),
    ).toEqual({ action: "redrive", redrives: 5 });
  });

  it("redrive budget exhausted → poison (deterministic failure)", () => {
    expect(
      decideOtelRedrive({
        ...base,
        firstSeenTs: base.now - HOUR,
        redrivesSoFar: 5,
      }),
    ).toEqual({ action: "poison", cause: "redrives-exhausted" });
  });

  it("older than the label retention window → poison, NEVER redrive", () => {
    // The dedup label has been purged from the FE registry — a blind replay
    // would double-load. Age wins even with redrive budget left.
    expect(
      decideOtelRedrive({
        ...base,
        firstSeenTs: base.now - 3 * DAY - 1,
        redrivesSoFar: 0,
      }),
    ).toEqual({ action: "poison", cause: "age" });
  });

  it("exactly at the window edge → still redrivable", () => {
    expect(
      decideOtelRedrive({
        ...base,
        firstSeenTs: base.now - 3 * DAY,
        redrivesSoFar: 0,
      }),
    ).toEqual({ action: "redrive", redrives: 1 });
  });
});
