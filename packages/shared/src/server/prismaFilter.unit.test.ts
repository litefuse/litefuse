import { describe, expect, it } from "vitest";

import {
  compilePrismaFilters,
  stringFilterToPrisma,
  stringOptionsFilterToPrisma,
} from "./prismaFilter";

const stringFilter = (operator: "=" | "contains" | "does not contain" | "starts with" | "ends with", value: string) =>
  ({
    type: "string" as const,
    column: "name",
    operator,
    value,
  }) as const;

describe("stringFilterToPrisma", () => {
  // Prisma's NestedStringFilter has no `mode` member, so `mode` may only sit on
  // the top-level StringFilter. Nesting it inside `not` makes Prisma reject the
  // whole query with "Unknown argument `mode`".
  it("keeps the case-insensitive mode at the top level for negated matches", () => {
    const where = stringFilterToPrisma(stringFilter("does not contain", "21"));

    expect(where).toEqual({ not: { contains: "21" }, mode: "insensitive" });
    expect(where.not).toBeDefined();
    expect(
      typeof where.not === "object" && where.not !== null && "mode" in where.not,
    ).toBe(false);
  });

  it("still serialises the positive operators", () => {
    expect(stringFilterToPrisma(stringFilter("=", "a"))).toEqual({
      equals: "a",
      mode: "insensitive",
    });
    expect(stringFilterToPrisma(stringFilter("contains", "a"))).toEqual({
      contains: "a",
      mode: "insensitive",
    });
    expect(stringFilterToPrisma(stringFilter("starts with", "a"))).toEqual({
      startsWith: "a",
      mode: "insensitive",
    });
    expect(stringFilterToPrisma(stringFilter("ends with", "a"))).toEqual({
      endsWith: "a",
      mode: "insensitive",
    });
  });
});

describe("compilePrismaFilters", () => {
  const handlers = {
    name: {
      string: (filter: { operator: string; value: string }) =>
        stringFilterToPrisma(
          filter as Parameters<typeof stringFilterToPrisma>[0],
        ),
      stringOptions: (filter: unknown) =>
        stringOptionsFilterToPrisma(
          filter as Parameters<typeof stringOptionsFilterToPrisma>[0],
        ),
    },
  };

  // A half-typed filter (the value got cleared, or every option was unchecked)
  // carries no constraint. Emitting it anyway made `does not contain ""` return
  // zero rows and made an empty option list filter everything out.
  it("drops a text filter whose value was cleared", () => {
    expect(
      compilePrismaFilters(
        [
          {
            type: "string",
            column: "name",
            operator: "does not contain",
            value: "",
          },
        ] as never,
        handlers as never,
      ),
    ).toEqual([]);
  });

  it("drops an option filter with no selected values", () => {
    expect(
      compilePrismaFilters(
        [
          {
            type: "stringOptions",
            column: "name",
            operator: "any of",
            value: [],
          },
        ] as never,
        handlers as never,
      ),
    ).toEqual([]);
  });

  it("keeps a whitespace-only text filter", () => {
    expect(
      compilePrismaFilters(
        [
          {
            type: "string",
            column: "name",
            operator: "does not contain",
            value: " ",
          },
        ] as never,
        handlers as never,
      ),
    ).toEqual([{ not: { contains: " " }, mode: "insensitive" }]);
  });

  it("keeps ordinary filters", () => {
    expect(
      compilePrismaFilters(
        [{ type: "string", column: "name", operator: "contains", value: "a" }] as never,
        handlers as never,
      ),
    ).toEqual([{ contains: "a", mode: "insensitive" }]);
  });
});

describe("stringOptionsFilterToPrisma", () => {
  it("puts mode beside in/notIn", () => {
    expect(
      stringOptionsFilterToPrisma({
        type: "stringOptions",
        column: "name",
        operator: "any of",
        value: ["a"],
      }),
    ).toEqual({ in: ["a"], mode: "insensitive" });
    expect(
      stringOptionsFilterToPrisma({
        type: "stringOptions",
        column: "name",
        operator: "none of",
        value: ["a"],
      }),
    ).toEqual({ notIn: ["a"], mode: "insensitive" });
  });
});
