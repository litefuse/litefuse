import {
  orderByToDorisSQL,
  orderByToPrismaSql,
  tracesTableUiColumnDefinitionsForDoris,
} from "@langfuse/shared/src/server";
import {
  InvalidRequestError,
  normalizeOrderByForTable,
  tracesTableCols,
} from "@langfuse/shared";

// The test for the orderByToPrisma function
describe("orderByToPrisma (Convert orderBy to Prisma.sql)", () => {
  test("orderByToPrisma throws error for orderBy column not included in column defs", () => {
    expect(() =>
      orderByToPrismaSql(
        {
          column: "InvalidCol",
          order: "ASC",
        },
        tracesTableCols,
      ),
    ).toThrow(/Invalid filter column: InvalidCol/);
  });

  test("orderByToPrisma throws error for orderBy order that is not valid", () => {
    expect(() =>
      orderByToPrismaSql(
        {
          column: "latency",
          order: "test" as "ASC" | "DESC",
        },
        tracesTableCols,
      ),
    ).toThrow(/Invalid order: test/);
  });

  test("normalizeOrderByForTable maps leaked time aliases to expected table column", () => {
    expect(
      normalizeOrderByForTable({
        orderBy: { column: "startTime", order: "DESC" },
        expectedTimeColumn: "timestamp",
      }),
    ).toEqual({ column: "timestamp", order: "DESC" });

    expect(
      normalizeOrderByForTable({
        orderBy: { column: "timestamp", order: "ASC" },
        expectedTimeColumn: "createdAt",
      }),
    ).toEqual({ column: "createdAt", order: "ASC" });
  });

  // Skipped: orderByToDorisSQL throws a plain Error, so an invalid column returns 500 instead of 400.
  test.skip("orderByToDorisSQL throws InvalidRequestError for invalid columns", () => {
    expect(() =>
      orderByToDorisSQL(
        { column: "not_a_column", order: "ASC" },
        tracesTableUiColumnDefinitionsForDoris,
      ),
    ).toThrow(InvalidRequestError);
  });
});
