import { ListRulesSchema } from "./ruleTypes";
import { dropEmptyOptionSelections } from "../filterInputNormalization";

// Regression: `evalsV2.rules.list` answered 400 (`filter[0].value: Invalid
// input`) when a `stringOptions` filter with an empty value list reached it, so
// the rules page failed as soon as a filter was touched on a project without
// rules. The list input now treats an empty option selection as "no
// constraint" instead of rejecting the whole query.
describe("dropEmptyOptionSelections", () => {
  it("drops an empty stringOptions value", () => {
    expect(
      dropEmptyOptionSelections([
        {
          column: "name",
          type: "stringOptions",
          operator: "any of",
          value: [],
        },
      ]),
    ).toEqual([]);
  });

  it("keeps the arrayOptions all-of placeholder", () => {
    expect(
      dropEmptyOptionSelections([
        { column: "tags", type: "arrayOptions", operator: "all of", value: [] },
      ]),
    ).toEqual([
      { column: "tags", type: "arrayOptions", operator: "all of", value: [] },
    ]);
  });

  it("passes non-array input through so zod still reports it", () => {
    expect(dropEmptyOptionSelections("nope")).toBe("nope");
    expect(dropEmptyOptionSelections(undefined)).toBeUndefined();
  });

  it("leaves real selections alone", () => {
    const filters = [
      {
        column: "name",
        type: "stringOptions",
        operator: "any of",
        value: ["a"],
      },
    ];
    expect(dropEmptyOptionSelections(filters)).toEqual(filters);
  });
});

describe("ListRulesSchema filter input", () => {
  it("accepts an empty option selection by ignoring it", () => {
    const parsed = ListRulesSchema.parse({
      projectId: "project-1",
      filter: [
        {
          column: "name",
          type: "stringOptions",
          operator: "any of",
          value: [],
        },
      ],
    });

    expect(parsed.filter).toEqual([]);
  });

  it("still rejects a column the rules list cannot filter on", () => {
    const result = ListRulesSchema.safeParse({
      projectId: "project-1",
      filter: [
        {
          column: "environment",
          type: "stringOptions",
          operator: "any of",
          value: ["production"],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("keeps valid filters next to the dropped one", () => {
    const parsed = ListRulesSchema.parse({
      projectId: "project-1",
      filter: [
        {
          column: "name",
          type: "stringOptions",
          operator: "any of",
          value: [],
        },
        { column: "enabled", type: "boolean", operator: "=", value: true },
      ],
    });

    expect(parsed.filter).toEqual([
      { column: "enabled", type: "boolean", operator: "=", value: true },
    ]);
  });
});
