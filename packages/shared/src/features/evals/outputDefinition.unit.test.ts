import { describe, expect, it } from "vitest";
import { ScoreDataTypeEnum } from "../../domain/scores";
import {
  CategoricalEvalOutputDefinitionV2Schema,
  compilePersistedEvalOutputDefinition,
  createBooleanEvalOutputDefinition,
  createCategoricalEvalOutputDefinition,
  createNumericEvalOutputDefinition,
  resolvePersistedEvalOutputDefinition,
  validateEvalOutputResult,
} from "./outputDefinition";

describe("eval output definitions", () => {
  it("resolves legacy output definitions as numeric", () => {
    expect(
      resolvePersistedEvalOutputDefinition({
        score: "A number between 0 and 1",
        reasoning: "Explain the score",
      }),
    ).toEqual({
      dataType: ScoreDataTypeEnum.NUMERIC,
      scoreDescription: "A number between 0 and 1",
      reasoningDescription: "Explain the score",
    });
  });

  it("validates numeric outputs", () => {
    const compiled = compilePersistedEvalOutputDefinition(
      createNumericEvalOutputDefinition({
        scoreDescription: "A number between 0 and 1",
        reasoningDescription: "Explain the score",
      }),
    );

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { score: 0.8, reasoning: "Looks good" },
      }),
    ).toEqual({
      success: true,
      data: {
        dataType: ScoreDataTypeEnum.NUMERIC,
        score: 0.8,
        reasoning: "Looks good",
      },
    });

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { score: true, reasoning: "Wrong type" },
      }).success,
    ).toBe(false);
  });

  it("validates boolean outputs", () => {
    const compiled = compilePersistedEvalOutputDefinition(
      createBooleanEvalOutputDefinition({
        scoreDescription: "Return true when correct",
        reasoningDescription: "Explain the verdict",
      }),
    );

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { score: true, reasoning: "Correct" },
      }),
    ).toEqual({
      success: true,
      data: {
        dataType: ScoreDataTypeEnum.BOOLEAN,
        score: true,
        reasoning: "Correct",
      },
    });

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { score: "true", reasoning: "Wrong type" },
      }).success,
    ).toBe(false);
  });

  it("validates single categorical outputs", () => {
    const compiled = compilePersistedEvalOutputDefinition(
      createCategoricalEvalOutputDefinition({
        scoreDescription: "Choose one category",
        reasoningDescription: "Explain the category",
        categories: ["helpful", "unsafe"],
      }),
    );

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { score: "helpful", reasoning: "Good answer" },
      }),
    ).toEqual({
      success: true,
      data: {
        dataType: ScoreDataTypeEnum.CATEGORICAL,
        matches: ["helpful"],
        reasoning: "Good answer",
      },
    });

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { score: "unknown", reasoning: "Invalid category" },
      }).success,
    ).toBe(false);
  });

  it("validates multi-match categorical outputs", () => {
    const compiled = compilePersistedEvalOutputDefinition(
      createCategoricalEvalOutputDefinition({
        scoreDescription: "Choose categories",
        reasoningDescription: "Explain the categories",
        categories: ["helpful", "safe", "concise"],
        shouldAllowMultipleMatches: true,
      }),
    );

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: { score: ["helpful", "safe"], reasoning: "Both apply" },
      }),
    ).toEqual({
      success: true,
      data: {
        dataType: ScoreDataTypeEnum.CATEGORICAL,
        matches: ["helpful", "safe"],
        reasoning: "Both apply",
      },
    });

    expect(
      validateEvalOutputResult({
        compiledOutputDefinition: compiled,
        response: {
          score: ["helpful", "helpful"],
          reasoning: "Duplicate category",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid categorical definitions", () => {
    expect(
      CategoricalEvalOutputDefinitionV2Schema.safeParse({
        version: 2,
        dataType: ScoreDataTypeEnum.CATEGORICAL,
        reasoning: { description: "Explain the category" },
        score: {
          description: "Choose a category",
          categories: ["helpful", "helpful"],
          shouldAllowMultipleMatches: false,
        },
      }).success,
    ).toBe(false);
  });
});
