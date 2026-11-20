import { describe, it, expect } from "vitest";

import { classifyOtelFile } from "./classify";

const HOUR = 3600_000;
const NOW = 1_000_000 * HOUR;
const P = { now: NOW, olderThanMs: 80 * HOUR };

const facts = (over: Partial<Parameters<typeof classifyOtelFile>[0]> = {}) => ({
  fileKey: "otel/p1/x.json",
  createdAtMs: NOW - 100 * HOUR, // over-age by default
  hasLedger: false,
  isPoisoned: false,
  hasRegisteredKey: false,
  ...over,
});

describe("classifyOtelFile (reconciliation four-way)", () => {
  it("ledger wins over everything — completed files are never touched", () => {
    expect(
      classifyOtelFile(facts({ hasLedger: true, isPoisoned: true }), P),
    ).toEqual({ verdict: "ok" });
  });

  it("young files without ledger are in-flight, not losses", () => {
    expect(classifyOtelFile(facts({ createdAtMs: NOW - HOUR }), P)).toEqual({
      verdict: "in-flight",
    });
  });

  it("poison outranks reinject — deterministic failures go to the runbook", () => {
    expect(
      classifyOtelFile(facts({ isPoisoned: true, hasRegisteredKey: true }), P),
    ).toEqual({ verdict: "poisoned" });
  });

  it("over-age + registration trace ⇒ pointer lost inside the pipeline → reinject", () => {
    expect(classifyOtelFile(facts({ hasRegisteredKey: true }), P)).toEqual({
      verdict: "reinject",
    });
  });

  it("over-age with NO evidence → manual audit (A2 orphan would duplicate)", () => {
    const v = classifyOtelFile(facts(), P);
    expect(v.verdict).toBe("audit");
  });
});
