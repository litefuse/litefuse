import { describe, expect, it } from "vitest";
import { ScoreDataTypeEnum } from "../../domain/scores";
import {
  compilePersistedEvalOutputDefinition,
  createCategoricalEvalOutputDefinition,
  validateEvalOutputResult,
} from "./outputDefinition";

describe("eval output definitions", () => {
  it("keeps legacy numeric definitions compatible", () => {
    const compiled = compilePersistedEvalOutputDefinition({
      reasoning: "why",
      score: "score",
    });
    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { reasoning: "because", score: 0.5 },
      }),
    ).toEqual({
      success: true,
      data: {
        dataType: ScoreDataTypeEnum.NUMERIC,
        reasoning: "because",
        score: 0.5,
      },
    });
  });

  it("validates boolean and multi-match categorical results", () => {
    const boolean = compilePersistedEvalOutputDefinition({
      version: 2,
      dataType: ScoreDataTypeEnum.BOOLEAN,
      reasoning: { description: "why" },
      score: { description: "yes/no" },
    });
    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: boolean,
        response: { reasoning: "ok", score: true },
      }).success,
    ).toBe(true);

    const categorical = compilePersistedEvalOutputDefinition(
      createCategoricalEvalOutputDefinition({
        reasoningDescription: "why",
        scoreDescription: "label",
        categories: ["A", "B"],
        shouldAllowMultipleMatches: true,
      }),
    );
    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: categorical,
        response: { reasoning: "ok", score: ["A", "B"] },
      }).success,
    ).toBe(true);
    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: categorical,
        response: { reasoning: "ok", score: ["A", "A"] },
      }).success,
    ).toBe(false);
  });

  it("rejects insufficient and duplicate category definitions", () => {
    expect(() =>
      createCategoricalEvalOutputDefinition({
        reasoningDescription: "why",
        scoreDescription: "label",
        categories: ["A"],
      }),
    ).toThrow();
    expect(() =>
      createCategoricalEvalOutputDefinition({
        reasoningDescription: "why",
        scoreDescription: "label",
        categories: ["A", " A "],
      }),
    ).toThrow();
  });
});
