import { z } from "zod/v4";

/**
 * Treats an option filter with no values as "no constraint".
 *
 * The UI can legitimately hold an operator choice before any value is picked,
 * and that empty placeholder reaches a list query in several ways (a facet with
 * no options to select, a peek's in-memory filter state, which skips the URL
 * round-trip, URL/session storage written by an older client). The shared
 * schema rejects it — `stringOptionsFilter` refines `value.length > 0`, and
 * `arrayOptionsFilter` only allows empty for "all of", the documented "waiting
 * for selection" case — so the read endpoints answered 400 with
 * `filter[i].value: Invalid input` (seen on `evalsV2.rules.list`).
 *
 * Dropping the filter is the semantics the UI means: nothing selected filters
 * nothing. Genuinely invalid filters (unknown columns, wrong types) still fail
 * validation, so this does not hide bugs.
 */
export function dropEmptyOptionSelections(input: unknown): unknown {
  if (!Array.isArray(input)) return input;

  return input.filter((filter) => {
    if (!filter || typeof filter !== "object") return true;

    const { type, operator, value } = filter as {
      type?: unknown;
      operator?: unknown;
      value?: unknown;
    };

    if (!Array.isArray(value)) return true;
    if (type === "stringOptions") return value.length > 0;
    if (type === "arrayOptions") {
      return operator === "all of" || value.length > 0;
    }
    return true;
  });
}

/**
 * Wraps a filter-list schema so empty option selections are dropped before it
 * validates. The cast keeps the declared input/output types unchanged: only the
 * runtime normalisation is added.
 */
export function toleratesEmptyOptionSelections<T extends z.ZodType>(
  schema: T,
): T {
  return z.preprocess(dropEmptyOptionSelections, schema) as unknown as T;
}
