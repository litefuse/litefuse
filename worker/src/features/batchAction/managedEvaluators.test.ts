import { describe, expect, it } from "vitest";
import managedEvaluators from "@/src/server/background/constants/managed-evaluators.json";

describe("managed evaluators", () => {
  it("includes the three historical evaluator library templates from langfuse ck", () => {
    const byName = new Map(
      managedEvaluators.map((evaluator) => [evaluator.name, evaluator]),
    );

    expect(byName.get("User Distress")).toMatchObject({
      id: "cmal6wart010lynrdtpv6olal",
      name: "User Distress",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    expect(byName.get("User Disagreement")).toMatchObject({
      id: "cmal6wart010lynrdtpv6olam",
      name: "User Disagreement",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    expect(byName.get("Out-of-Scope Request")).toMatchObject({
      id: "cmal6wart010lynrdtpv6olan",
      name: "Out-of-Scope Request",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
  });
});
