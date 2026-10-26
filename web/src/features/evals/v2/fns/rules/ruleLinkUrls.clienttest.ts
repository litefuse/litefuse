import {
  decodeFiltersGeneric,
  type FilterState,
  MAX_URL_FILTER_QUERY_LENGTH,
} from "@langfuse/shared";

import {
  ruleFilterToTraceFilter,
  ruleScoresUrl,
  ruleTracesUrl,
} from "./ruleLinkUrls";

const environmentFilter = (environment: string): FilterState => [
  {
    column: "environment",
    type: "stringOptions",
    operator: "any of",
    value: [environment],
  },
];

const filtersOf = (href: string): FilterState =>
  decodeFiltersGeneric(
    new URL(href, "http://localhost:3000").searchParams.get("filter") ?? "",
  );

describe("ruleFilterToTraceFilter", () => {
  it("keeps the conditions the traces surface defines the same way", () => {
    const ruleFilter: FilterState = [
      ...environmentFilter("zm_demo"),
      {
        column: "name",
        type: "stringOptions",
        operator: "any of",
        value: ["x"],
      },
      {
        column: "traceName",
        type: "stringOptions",
        operator: "any of",
        value: ["support-reply"],
      },
      {
        column: "tags",
        type: "arrayOptions",
        operator: "any of",
        value: ["billing"],
      },
      {
        column: "metadata",
        type: "stringObject",
        operator: "contains",
        key: "tenant",
        value: "acme",
      },
      {
        column: "level",
        type: "stringOptions",
        operator: "any of",
        value: ["ERROR"],
      },
      { column: "userId", type: "string", operator: "contains", value: "u-1" },
      {
        column: "sessionId",
        type: "string",
        operator: "contains",
        value: "s-1",
      },
      { column: "version", type: "string", operator: "contains", value: "1" },
      { column: "release", type: "string", operator: "contains", value: "r" },
    ];

    expect(ruleFilterToTraceFilter(ruleFilter)).toEqual(ruleFilter);
  });

  it("drops observation-only conditions instead of claiming them", () => {
    const ruleFilter: FilterState = [
      ...environmentFilter("zm_demo"),
      {
        column: "type",
        type: "stringOptions",
        operator: "any of",
        value: ["GENERATION"],
      },
      {
        column: "isRootObservation",
        type: "boolean",
        operator: "=",
        value: true,
      },
      {
        column: "providedModelName",
        type: "string",
        operator: "contains",
        value: "gpt",
      },
      { column: "input", type: "string", operator: "contains", value: "hi" },
    ];

    expect(ruleFilterToTraceFilter(ruleFilter)).toEqual(
      environmentFilter("zm_demo"),
    );
  });

  it("drops a condition whose type means something else on this surface", () => {
    // `userId` is `stringOptions` on the observation surface but a plain `string`
    // on traces, so the operator sets differ and the condition is not carried.
    expect(
      ruleFilterToTraceFilter([
        {
          column: "userId",
          type: "stringOptions",
          operator: "any of",
          value: ["u-1"],
        },
      ]),
    ).toEqual([]);
  });
});

describe("ruleTracesUrl", () => {
  it("encodes the rule's filter", () => {
    const href = ruleTracesUrl({
      projectId: "project/id",
      filter: environmentFilter("zm_demo"),
    });

    expect(new URL(href, "http://localhost:3000").pathname).toBe(
      "/project/project%2Fid/traces",
    );
    expect(filtersOf(href)).toEqual(environmentFilter("zm_demo"));
  });

  it("omits the filter param when the rule has nothing this surface can apply", () => {
    // An unfiltered rule evaluates every trace, so the plain list is correct.
    const href = ruleTracesUrl({
      projectId: "project-1",
      filter: [
        {
          column: "type",
          type: "stringOptions",
          operator: "any of",
          value: ["GENERATION"],
        },
      ],
    });

    expect(href).toBe("/project/project-1/traces");
    expect(
      new URL(href, "http://localhost:3000").searchParams.has("filter"),
    ).toBe(false);
  });
});

describe("ruleScoresUrl", () => {
  it("filters the scores list by name, source and the rule's environments", () => {
    const href = ruleScoresUrl({
      projectId: "project-1",
      scoreNames: ["Judge / choice", "Judge / score"],
      filter: environmentFilter("zm_demo"),
    });

    expect(href).not.toBeNull();
    if (href === null) throw new Error("expected a scores URL");

    const url = new URL(href, "http://localhost:3000");
    expect(url.pathname).toBe("/project/project-1/scores");
    expect(url.searchParams.get("showAllEnvironments")).toBe("true");
    expect(filtersOf(href)).toEqual([
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
        value: ["Judge / choice", "Judge / score"],
      },
      {
        column: "environment",
        type: "stringOptions",
        operator: "any of",
        value: ["zm_demo"],
      },
    ]);
  });

  it("returns null when the rule has no score names, so the caller cannot link", () => {
    expect(ruleScoresUrl({ projectId: "project-1", scoreNames: [] })).toBeNull();
  });

  it("returns null when even one name overflows the query string", () => {
    expect(
      ruleScoresUrl({
        projectId: "project-1",
        scoreNames: ["n".repeat(MAX_URL_FILTER_QUERY_LENGTH)],
      }),
    ).toBeNull();
  });

  it("truncates the name list rather than letting the page fall back to no filter", () => {
    const scoreNames = Array.from(
      { length: 80 },
      (_, index) => `score-name-${index}-${"x".repeat(80)}`,
    );

    const href = ruleScoresUrl({ projectId: "project-1", scoreNames });

    expect(href).not.toBeNull();
    if (href === null) throw new Error("expected a scores URL");

    expect(href.length).toBeLessThan(MAX_URL_FILTER_QUERY_LENGTH);

    const nameCondition = filtersOf(href).find(
      (condition) => condition.column === "name",
    );
    if (nameCondition?.type !== "stringOptions") {
      throw new Error("expected a name condition");
    }

    expect(nameCondition.value.length).toBeGreaterThan(0);
    expect(nameCondition.value.length).toBeLessThan(scoreNames.length);
    // Truncation drops the rarest names from the tail, not the filter itself.
    expect(nameCondition.value).toEqual(
      scoreNames.slice(0, nameCondition.value.length),
    );
  });
});
