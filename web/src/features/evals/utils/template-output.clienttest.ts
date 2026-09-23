import { describe, expect, it } from "@jest/globals";
import { getTemplateResultType } from "./template-output";

describe("getTemplateResultType", () => {
  it("identifies legacy and versioned eval output schemas", () => {
    expect(getTemplateResultType({ reasoning: "why", score: "score" })).toBe(
      "Numeric",
    );
    expect(
      getTemplateResultType({
        version: 2,
        dataType: "BOOLEAN",
        reasoning: { description: "why" },
        score: { description: "score" },
      }),
    ).toBe("Boolean");
    expect(
      getTemplateResultType({
        version: 2,
        dataType: "CATEGORICAL",
        reasoning: { description: "why" },
        score: { description: "score", categories: ["A", "B"] },
      }),
    ).toBe("Categorical");
  });

  it("labels invalid schemas as unknown", () => {
    expect(getTemplateResultType({ unrelated: "value" })).toBe("Unknown");
  });
});
