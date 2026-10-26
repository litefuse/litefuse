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

/**
 * Replace random param names like `stringFilterAb3x` with `P` for stable assertions.
 *
 * NOTE (Litefuse): these classes emit the Doris dialect in this fork, which
 * inlines every literal and returns no bind params at all (see
 * `packages/shared/src/server/queries/doris-sql/doris-filter.ts`). `norm()` is
 * therefore a no-op for the strings asserted below; it is kept because it is
 * what makes the assertions stable if a param-carrying form ever returns.
 */
const norm = (sql: string) =>
  sql.replace(/string(Filter|OptionsFilter)\w+/g, "P");

describe("StringFilter with emptyEqualsNull", () => {
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
    paramValues: unknown[];
  }>([
    {
      desc: "= non-empty (unchanged)",
      operator: "=",
      value: "alice",
      expectedQuery: `${C} = 'alice'`,
      paramValues: [],
    },
    {
      desc: "= empty → match '' and NULL",
      operator: "=",
      value: "",
      expectedQuery: `(${C} IS NULL OR ${C} = '')`,
      paramValues: [],
    },
    {
      desc: "contains (unchanged)",
      operator: "contains",
      value: "ali",
      expectedQuery: `INSTR(${C}, 'ali') > 0`,
      paramValues: [],
    },
    {
      desc: "does not contain → guard empty",
      operator: "does not contain",
      value: "ali",
      expectedQuery: `(${C} IS NOT NULL AND ${C} != '') AND INSTR(${C}, 'ali') = 0`,
      paramValues: [],
    },
    {
      desc: "contains empty → match '' and NULL",
      operator: "contains",
      value: "",
      expectedQuery: `(${C} IS NULL OR ${C} = '')`,
      paramValues: [],
    },
    {
      desc: "starts with (unchanged)",
      operator: "starts with",
      value: "ali",
      expectedQuery: `STARTS_WITH(${C}, 'ali')`,
      paramValues: [],
    },
    {
      desc: "starts with empty → match '' and NULL",
      operator: "starts with",
      value: "",
      expectedQuery: `(${C} IS NULL OR ${C} = '')`,
      paramValues: [],
    },
    {
      desc: "ends with (unchanged)",
      operator: "ends with",
      value: "ice",
      expectedQuery: `ENDS_WITH(${C}, 'ice')`,
      paramValues: [],
    },
    {
      desc: "ends with empty → match '' and NULL",
      operator: "ends with",
      value: "",
      expectedQuery: `(${C} IS NULL OR ${C} = '')`,
      paramValues: [],
    },
  ])("$desc", ({ operator, value, expectedQuery, paramValues }) => {
    const { query, params } = new StringFilter({
      dorisTable: "",
      field: C,
      operator,
      value,
      emptyEqualsNull: true,
    }).apply();

    expect(norm(query)).toBe(expectedQuery);
    expect(Object.values(params)).toEqual(paramValues);
  });
});

describe("StringOptionsFilter with emptyEqualsNull", () => {
  it.each<{
    desc: string;
    operator: "any of" | "none of";
    values: string[];
    expectedQuery: string;
    paramValues: unknown[];
  }>([
    {
      desc: "any of (no empty, unchanged)",
      operator: "any of",
      values: ["a", "b"],
      expectedQuery: `${C} IN ('a', 'b')`,
      paramValues: [],
    },
    {
      desc: "any of (with empty) → OR IS NULL",
      operator: "any of",
      values: ["", "a"],
      expectedQuery: `(${C} IN ('', 'a') OR ${C} IS NULL)`,
      paramValues: [],
    },
    {
      desc: "none of (no empty) → AND != ''",
      operator: "none of",
      values: ["a"],
      expectedQuery: `(${C} NOT IN ('a') AND ${C} != '')`,
      paramValues: [],
    },
    {
      desc: "none of (with empty) → AND IS NOT NULL",
      operator: "none of",
      values: ["", "a"],
      expectedQuery: `(${C} NOT IN ('', 'a') AND ${C} IS NOT NULL)`,
      paramValues: [],
    },
  ])("$desc", ({ operator, values, expectedQuery, paramValues }) => {
    const { query, params } = new StringOptionsFilter({
      dorisTable: "",
      field: C,
      operator,
      values,
      emptyEqualsNull: true,
    }).apply();

    expect(norm(query)).toBe(expectedQuery);
    expect(Object.values(params)).toEqual(paramValues);
  });
});

describe("NullFilter with emptyEqualsNull", () => {
  it.each<{
    desc: string;
    operator: "is null" | "is not null";
    expectedQuery: string;
  }>([
    {
      desc: "is null → match '' and NULL",
      operator: "is null",
      expectedQuery: `(${C} IS NULL OR ${C} = '')`,
    },
    {
      desc: "is not null → exclude '' and NULL",
      operator: "is not null",
      expectedQuery: `(${C} IS NOT NULL AND ${C} != '')`,
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
