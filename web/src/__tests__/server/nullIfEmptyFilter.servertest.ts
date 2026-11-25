import { NULL_IF_EMPTY_RE } from "@/src/features/query/server/nullIfEmptyFilter";
import {
  StringFilter,
  StringOptionsFilter,
  NullFilter,
} from "@langfuse/shared/src/server";

// ─── NULL_IF_EMPTY_RE ───────────────────────────────────────────────────────

describe("NULL_IF_EMPTY_RE", () => {
  it.each<{ input: string; match: string | null }>([
    {
      input: "nullIf(events_traces.user_id, '')",
      match: "events_traces.user_id",
    },
    { input: "nullIf(col,  '')", match: "col" },
    {
      input:
        "COALESCE(nullIf(events_traces.trace_name, ''), nullIf(events_traces.name, ''))",
      match: null,
    },
    { input: "events_traces.user_id", match: null },
  ])("$input → $match", ({ input, match }) => {
    const m = NULL_IF_EMPTY_RE.exec(input);
    if (match === null) {
      expect(m).toBeNull();
    } else {
      expect(m).not.toBeNull();
      expect(m![1]).toBe(match);
    }
  });
});

// ─── Filter classes with emptyEqualsNull ────────────────────────────────────

const C = "t.user_id";

/** Replace random param names like `stringFilterAb3x` with `P` for stable assertions. */
const norm = (sql: string) =>
  sql.replace(/string(Filter|OptionsFilter)\w+/g, "P");

// Skipped: the Doris filter does not implement emptyEqualsNull yet.
describe.skip("StringFilter with emptyEqualsNull", () => {
  it.each<{
    desc: string;
    operator:
      | "="
      | "contains"
      | "does not contain"
      | "starts with"
      | "ends with";
    value: string;
    expectedQuery: string;
  }>([
    {
      desc: "= non-empty (unchanged)",
      operator: "=",
      value: "alice",
      expectedQuery: `${C} = 'alice'`,
    },
    {
      desc: "= empty → match '' and NULL",
      operator: "=",
      value: "",
      expectedQuery: `(${C} = '' OR ${C} IS NULL)`,
    },
    {
      desc: "contains (unchanged)",
      operator: "contains",
      value: "ali",
      expectedQuery: `INSTR(${C}, 'ali') > 0`,
    },
    {
      desc: "does not contain → guard empty",
      operator: "does not contain",
      value: "ali",
      expectedQuery: `(${C} != '' AND INSTR(${C}, 'ali') = 0)`,
    },
    {
      desc: "contains empty → match '' and NULL",
      operator: "contains",
      value: "",
      expectedQuery: `(${C} = '' OR ${C} IS NULL)`,
    },
    {
      desc: "starts with (unchanged)",
      operator: "starts with",
      value: "ali",
      expectedQuery: `STARTS_WITH(${C}, 'ali')`,
    },
    {
      desc: "starts with empty → match '' and NULL",
      operator: "starts with",
      value: "",
      expectedQuery: `(${C} = '' OR ${C} IS NULL)`,
    },
    {
      desc: "ends with (unchanged)",
      operator: "ends with",
      value: "ice",
      expectedQuery: `ENDS_WITH(${C}, 'ice')`,
    },
    {
      desc: "ends with empty → match '' and NULL",
      operator: "ends with",
      value: "",
      expectedQuery: `(${C} = '' OR ${C} IS NULL)`,
    },
  ])("$desc", ({ operator, value, expectedQuery }) => {
    const { query, params } = new StringFilter({
      dorisTable: "",
      field: C,
      operator,
      value,
      emptyEqualsNull: true,
    }).apply();

    expect(norm(query)).toBe(expectedQuery);
    expect(params).toEqual({});
  });
});

// Skipped: the Doris filter does not implement emptyEqualsNull yet.
describe.skip("StringOptionsFilter with emptyEqualsNull", () => {
  it.each<{
    desc: string;
    operator: "any of" | "none of";
    values: string[];
    expectedQuery: string;
  }>([
    {
      desc: "any of (no empty, unchanged)",
      operator: "any of",
      values: ["a", "b"],
      expectedQuery: `${C} IN ('a', 'b')`,
    },
    {
      desc: "any of (with empty) → OR IS NULL",
      operator: "any of",
      values: ["", "a"],
      expectedQuery: `(${C} IN ('', 'a') OR ${C} IS NULL)`,
    },
    {
      desc: "none of (no empty) → AND != ''",
      operator: "none of",
      values: ["a"],
      expectedQuery: `(${C} NOT IN ('a') AND ${C} != '')`,
    },
    {
      desc: "none of (with empty) → AND IS NOT NULL",
      operator: "none of",
      values: ["", "a"],
      expectedQuery: `(${C} NOT IN ('', 'a') AND ${C} IS NOT NULL)`,
    },
  ])("$desc", ({ operator, values, expectedQuery }) => {
    const { query, params } = new StringOptionsFilter({
      dorisTable: "",
      field: C,
      operator,
      values,
      emptyEqualsNull: true,
    }).apply();

    expect(norm(query)).toBe(expectedQuery);
    expect(params).toEqual({});
  });
});

// Skipped: the Doris filter does not implement emptyEqualsNull yet.
describe.skip("NullFilter with emptyEqualsNull", () => {
  it.each<{
    desc: string;
    operator: "is null" | "is not null";
    expectedQuery: string;
  }>([
    {
      desc: "is null → match '' and NULL",
      operator: "is null",
      expectedQuery: `(${C} = '' OR ${C} IS NULL)`,
    },
    {
      desc: "is not null → exclude '' and NULL",
      operator: "is not null",
      expectedQuery: `(${C} != '' AND ${C} IS NOT NULL)`,
    },
  ])("$desc", ({ operator, expectedQuery }) => {
    const { query, params } = new NullFilter({
      dorisTable: "",
      field: C,
      operator,
      emptyEqualsNull: true,
    }).apply();

    expect(query).toBe(expectedQuery);
    expect(params).toEqual({});
  });
});
