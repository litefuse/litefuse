import {
  decodeFiltersGeneric,
  type EvalTemplateType,
  EvalTemplateTypeEnum,
  LangfuseInternalTraceEnvironment,
} from "@langfuse/shared";
import {
  evaluatorExecutionsUrl,
  evaluatorScoresUrl,
} from "./evaluatorScoresUrl";

describe("evaluatorScoresUrl", () => {
  it("filters the scores list by the names this evaluator actually wrote", () => {
    // A decision-model evaluator's own name is not a score name: one model call
    // writes one score per question, so all three names have to be in the filter.
    const href = evaluatorScoresUrl({
      projectId: "project-1",
      scoreNames: [
        "ZZ jev flow / choice",
        "ZZ jev flow / score",
        "ZZ jev flow / boolean (noul)",
      ],
    });

    expect(href).not.toBeNull();
    if (href === null) throw new Error("expected a scores URL");

    const url = new URL(href, "http://localhost:3000");
    expect(url.pathname).toBe("/project/project-1/scores");
    expect(url.searchParams.get("showAllEnvironments")).toBe("true");
    expect(decodeFiltersGeneric(url.searchParams.get("filter") ?? "")).toEqual([
      {
        column: "source",
        type: "stringOptions",
        operator: "any of",
        value: ["EVAL"],
      },
      {
        column: "name",
        type: "stringOptions",
        operator: "any of",
        value: [
          "ZZ jev flow / choice",
          "ZZ jev flow / score",
          "ZZ jev flow / boolean (noul)",
        ],
      },
    ]);
  });

  it("returns null when the evaluator has no scores, so the action stays disabled", () => {
    expect(
      evaluatorScoresUrl({ projectId: "project-1", scoreNames: [] }),
    ).toBeNull();
  });
});

const getFilters = (evaluatorType: EvalTemplateType) => {
  const url = new URL(
    evaluatorExecutionsUrl("project/id", "Quality", evaluatorType),
    "https://langfuse.local",
  );

  return {
    pathname: url.pathname,
    filters: decodeFiltersGeneric(url.searchParams.get("filter") ?? ""),
  };
};

describe("evaluatorExecutionsUrl", () => {
  it.each([
    [EvalTemplateTypeEnum.CODE, LangfuseInternalTraceEnvironment.CodeEval],
    [
      EvalTemplateTypeEnum.LLM_AS_JUDGE,
      LangfuseInternalTraceEnvironment.LLMJudge,
    ],
  ])(
    "forwards %s evaluators to their execution environment",
    (type, environment) => {
      expect(getFilters(type)).toEqual({
        pathname: "/project/project%2Fid/traces",
        filters: [
          {
            column: "traceName",
            type: "stringOptions",
            operator: "any of",
            value: ["Execute evaluator: Quality"],
          },
          {
            column: "environment",
            type: "stringOptions",
            operator: "any of",
            value: [environment],
          },
          {
            column: "isRootObservation",
            type: "boolean",
            operator: "=",
            value: true,
          },
        ],
      });
    },
  );
});
