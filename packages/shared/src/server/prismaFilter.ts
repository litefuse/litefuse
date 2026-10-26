import type { Prisma } from "@prisma/client";
import { InvalidRequestError } from "../errors";
import type { FilterState } from "../types";

type PrismaFilter = FilterState[number];
type PrismaFilterType = PrismaFilter["type"];

export type PrismaFilterColumnHandlers<TWhere> = {
  [Type in PrismaFilterType]?: (
    filter: Extract<PrismaFilter, { type: Type }>,
  ) => TWhere;
};

/**
 * A filter whose value was cleared (or an option list with nothing selected)
 * expresses no constraint, so it must not reach the query: `does not contain ""`
 * matched no rows at all and an empty `in: []` filtered everything out. Only a
 * truly empty value is dropped — a single space is a legitimate filter ("does
 * not contain ' '"), which is why this does not trim.
 */
function isEmptyValue(filter: PrismaFilter): boolean {
  switch (filter.type) {
    case "string":
    case "stringOptions":
      return filter.value.length === 0;
    default:
      return false;
  }
}

export function compilePrismaFilters<TWhere>(
  filters: FilterState,
  handlers: Record<string, PrismaFilterColumnHandlers<TWhere>>,
): TWhere[] {
  return filters.flatMap((filter) => {
    if (isEmptyValue(filter)) return [];
    const handler = handlers[filter.column]?.[filter.type] as
      | ((filter: PrismaFilter) => TWhere)
      | undefined;
    if (!handler) {
      throw new InvalidRequestError(
        `Unsupported Prisma filter: ${filter.column} (${filter.type})`,
      );
    }
    return [handler(filter)];
  });
}

type StringFilter = Extract<PrismaFilter, { type: "string" }>;

export function stringFilterToPrisma(
  filter: StringFilter,
): Prisma.StringFilter {
  const insensitive = { mode: "insensitive" as const };

  switch (filter.operator) {
    case "=":
      return { equals: filter.value, ...insensitive };
    case "contains":
      return { contains: filter.value, ...insensitive };
    case "does not contain":
      // `mode` belongs on the top-level StringFilter only: Prisma's
      // NestedStringFilter (what `not` accepts) has no `mode` member, so
      // nesting it makes Prisma reject the whole query with
      // "Unknown argument `mode`". The `not` object below is written out
      // literally (no spread) so an accidental `mode` inside it fails
      // excess-property checking at compile time.
      return { not: { contains: filter.value }, ...insensitive };
    case "starts with":
      return { startsWith: filter.value, ...insensitive };
    case "ends with":
      return { endsWith: filter.value, ...insensitive };
    // LITEFUSE NOTE: upstream also handles "is not empty" here; our string filter
    // operators have no such member (long-standing filter divergence — we kept our
    // filter types and adapt upstream code instead).
  }
}

type StringOptionsFilter = Extract<PrismaFilter, { type: "stringOptions" }>;

export function stringOptionsFilterToPrisma(
  filter: StringOptionsFilter,
): Prisma.StringFilter {
  return filter.operator === "any of"
    ? { in: filter.value, mode: "insensitive" }
    : { notIn: filter.value, mode: "insensitive" };
}
