import z from "zod";
import { OrderByState } from "../../../interfaces/orderBy";
import { UiColumnMappings } from "../../../tableDefinitions";
import { logger } from "../../logger";

type OrderByStateNotNull = Exclude<OrderByState, null>;

export type OrderByScope =
  | "inner" // references base table(s) directly: "dri.`created_at`"
  | "projection"; // references the SELECT-list alias only: "`created_at`"

/**
 * Extract the alias a column is exposed under in the SELECT projection.
 *
 * UI column mappings currently encode the fully-qualified base-table
 * reference in `col.select` (e.g. "dri.`created_at`"). The projection-side
 * alias is the tail after the last ".", with surrounding backticks
 * preserved. This mirrors the convention used in our SELECT clauses, where
 * every column is aliased back to its bare name (e.g.
 * `dri.created_at AS created_at`).
 */
const projectionAliasFor = (select: string): string => {
  const lastDot = select.lastIndexOf(".");
  return lastDot === -1 ? select : select.slice(lastDot + 1);
};

export function orderByToDorisSQL(
  orderBy: OrderByState | OrderByState[] = [],
  tableColumns: UiColumnMappings,
  opts: { scope?: OrderByScope } = {},
): string {
  if (
    !orderBy ||
    (Array.isArray(orderBy) && orderBy.filter(Boolean).length === 0)
  ) {
    return "";
  }

  if (!Array.isArray(orderBy)) {
    orderBy = [orderBy];
  }

  const scope: OrderByScope = opts.scope ?? "inner";

  // Initialize an array to hold order by clauses
  const orderByClauses: string[] = [];

  // Loop through each orderBy entry
  for (const ob of orderBy.filter((o): o is OrderByStateNotNull =>
    Boolean(o),
  )) {
    // Get column definition to map column to internal name, e.g. "t.id"
    const col = tableColumns.find(
      (c) => c.uiTableName === ob.column || c.uiTableId === ob.column,
    );

    if (!col) {
      logger.warn("Invalid order by column", ob.column);
      throw new Error("Invalid order by column: " + ob.column);
    }

    // Assert that ob.order is either "asc" or "desc"
    const orderByOrder = z.enum(["ASC", "DESC"]);
    const order = orderByOrder.safeParse(ob.order);
    if (!order.success) {
      logger.warn("Invalid order", ob.order);
      throw new Error("Invalid order: " + ob.order);
    }

    // "inner" emits the fully-qualified reference (valid only where the
    // base-table alias is in scope: WHERE / GROUP BY / window ORDER BY).
    // "projection" emits just the SELECT-list alias; use this for outer
    // ORDER BY over a subquery or when base-table aliases are no longer
    // resolvable (e.g. after QUALIFY in Doris Nereids).
    const ref =
      scope === "projection"
        ? projectionAliasFor(col.select)
        : `${col.queryPrefix ? col.queryPrefix + "." : ""}${col.select}`;

    orderByClauses.push(`${ref} ${order.data}`);
  }

  // Join all order by clauses with a comma and return
  return `ORDER BY ${orderByClauses.join(", ")}`;
}
