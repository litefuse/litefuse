/** @jest-environment node */

import {
  createBooleanEvalOutputDefinition,
  createCategoricalEvalOutputDefinition,
  createNumericEvalOutputDefinition,
} from "@langfuse/shared";
import { CreateEvalTemplate } from "@/src/features/evals/server/router";

describe("CreateEvalTemplate output definition", () => {
  const baseTemplateInput = {
    name: "Judge template",
    projectId: "project-1",
    prompt: "Judge {{input}}",
    provider: "openai",
    model: "gpt-4o-mini",
    modelParams: {},
    vars: ["input"],
  };

  it("accepts legacy numeric output schemas", () => {
    expect(
      CreateEvalTemplate.safeParse({
        ...baseTemplateInput,
        outputSchema: {
          score: "A number between 0 and 1",
          reasoning: "Explain the score",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts v2 numeric output definitions", () => {
    expect(
      CreateEvalTemplate.safeParse({
        ...baseTemplateInput,
        outputSchema: createNumericEvalOutputDefinition({
          scoreDescription: "A number between 0 and 1",
          reasoningDescription: "Explain the score",
        }),
      }).success,
    ).toBe(true);
  });

  it("accepts v2 boolean output definitions", () => {
    expect(
      CreateEvalTemplate.safeParse({
        ...baseTemplateInput,
        outputSchema: createBooleanEvalOutputDefinition({
          scoreDescription: "Return true when the answer is correct",
          reasoningDescription: "Explain the verdict",
        }),
      }).success,
    ).toBe(true);
  });

  it("accepts v2 categorical output definitions", () => {
    expect(
      CreateEvalTemplate.safeParse({
        ...baseTemplateInput,
        outputSchema: createCategoricalEvalOutputDefinition({
          scoreDescription: "Choose the matching category",
          reasoningDescription: "Explain the category",
          categories: ["helpful", "unsafe"],
          shouldAllowMultipleMatches: true,
        }),
      }).success,
    ).toBe(true);
  });

  it("rejects invalid output definitions", () => {
    expect(
      CreateEvalTemplate.safeParse({
        ...baseTemplateInput,
        outputSchema: { invalidKey: "value" },
      }).success,
    ).toBe(false);
  });

  it("rejects categorical output definitions with duplicate categories", () => {
    expect(
      CreateEvalTemplate.safeParse({
        ...baseTemplateInput,
        outputSchema: {
          version: 2,
          dataType: "CATEGORICAL",
          reasoning: {
            description: "Explain the category",
          },
          score: {
            description: "Choose the matching category",
            categories: ["helpful", "helpful"],
            shouldAllowMultipleMatches: false,
          },
        },
      }).success,
    ).toBe(false);
  });
});
