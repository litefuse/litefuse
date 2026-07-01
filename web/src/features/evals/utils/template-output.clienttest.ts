import {
  createBooleanEvalOutputDefinition,
  createCategoricalEvalOutputDefinition,
  createNumericEvalOutputDefinition,
} from "@langfuse/shared";
import { getTemplateResultType } from "./template-output";

describe("getTemplateResultType", () => {
  it("returns Numeric for legacy output schemas", () => {
    expect(
      getTemplateResultType({
        score: "Score between 0 and 1",
        reasoning: "Explain the score",
      }),
    ).toBe("Numeric");
  });

  it("returns Numeric for v2 numeric output definitions", () => {
    expect(
      getTemplateResultType(
        createNumericEvalOutputDefinition({
          scoreDescription: "Score between 0 and 1",
          reasoningDescription: "Explain the score",
        }),
      ),
    ).toBe("Numeric");
  });

  it("returns Boolean for v2 boolean output definitions", () => {
    expect(
      getTemplateResultType(
        createBooleanEvalOutputDefinition({
          scoreDescription: "Return true or false",
          reasoningDescription: "Explain the verdict",
        }),
      ),
    ).toBe("Boolean");
  });

  it("returns Categorical for v2 categorical output definitions", () => {
    expect(
      getTemplateResultType(
        createCategoricalEvalOutputDefinition({
          scoreDescription: "Choose a category",
          reasoningDescription: "Explain the category",
          categories: ["low", "high"],
        }),
      ),
    ).toBe("Categorical");
  });

  it("returns Unknown for invalid output definitions", () => {
    expect(getTemplateResultType({ foo: "bar" })).toBe("Unknown");
  });
});
