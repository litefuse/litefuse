import { env } from "@langfuse/shared/src/env";

/**
 * Returns the Langfuse Doris database name from environment config.
 */
export function getLangfuseDorisDb(): string {
  return env.DORIS_DB;
}

/**
 * Returns true if the given database name matches the Langfuse Doris database,
 * meaning queries against it must be filtered by project_id.
 */
export function isLangfuseDatabase(database: string | undefined): boolean {
  if (!database) return false;
  return database === getLangfuseDorisDb();
}

/**
 * Langfuse Doris tables that contain a `project_id` column and therefore
 * require per-project data isolation in the Discover feature.
 */
const LITEFUSE_TABLES_WITH_PROJECT_ID = new Set([
  "events_full",
  "scores",
  "event_log",
  "project_environments",
  "dataset_run_items",
  "dataset_run_items_rmt",
]);

/**
 * Extracts unqualified table names from the top-level FROM clause of a SELECT
 * query. Handles:
 *   - Qualified names:  `db`.`table`  →  "table"
 *   - Backtick quoting: `traces`       →  "traces"
 *   - Table aliases:    traces t        →  "traces"
 *   - Multiple tables / JOINs
 *
 * Subquery tables (inside parentheses) are intentionally ignored.
 * Returns an empty array if the FROM clause cannot be parsed.
 */
function extractFromTables(sql: string): string[] {
  const fromPos = findTopLevelKeyword(sql, "FROM");
  if (fromPos === -1) return [];

  // Collect text from after FROM until a top-level clause boundary
  const endKeywords = [
    "WHERE",
    "GROUP BY",
    "ORDER BY",
    "HAVING",
    "LIMIT",
    "UNION",
  ];
  let endPos = sql.length;
  for (const kw of endKeywords) {
    const pos = findTopLevelKeywordAfter(sql, kw, fromPos + 4);
    if (pos !== -1 && pos < endPos) endPos = pos;
  }

  const fromClause = sql.slice(fromPos + 4, endPos).trim();
  const tables: string[] = [];

  // Split on commas and JOIN keywords at the top level of the FROM clause
  // Each segment starts with a table reference (possibly qualified)
  const segments = splitFromClause(fromClause);

  for (const seg of segments) {
    const name = parseTableName(seg.trim());
    if (name) tables.push(name.toLowerCase());
  }

  return tables;
}

/**
 * Like findTopLevelKeyword but starts scanning from a given offset.
 */
function findTopLevelKeywordAfter(
  sql: string,
  keyword: string,
  startFrom: number,
): number {
  const sliced = sql.slice(startFrom);
  const pos = findTopLevelKeyword(sliced, keyword);
  return pos === -1 ? -1 : pos + startFrom;
}

/**
 * Splits a FROM clause text on top-level commas and JOIN keywords,
 * returning the individual table-reference segments.
 */
function splitFromClause(fromClause: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let inSingleQuote = false;
  let inBacktick = false;
  let segStart = 0;
  const upper = fromClause.toUpperCase();

  for (let i = 0; i < fromClause.length; i++) {
    const c = fromClause[i];

    if (inSingleQuote) {
      if (c === "'" && i + 1 < fromClause.length && fromClause[i + 1] === "'") {
        i++;
      } else if (c === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inBacktick) {
      if (c === "`") inBacktick = false;
      continue;
    }
    if (c === "'") {
      inSingleQuote = true;
      continue;
    }
    if (c === "`") {
      inBacktick = true;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;

    // Split on top-level comma
    if (c === ",") {
      segments.push(fromClause.slice(segStart, i));
      segStart = i + 1;
      continue;
    }

    // Split on JOIN keywords (INNER JOIN, LEFT JOIN, RIGHT JOIN, JOIN, etc.)
    const prevBoundary = i === 0 || /\s/.test(fromClause[i - 1]);
    if (prevBoundary && upper.startsWith("JOIN", i)) {
      const afterJoin = i + 4;
      if (afterJoin >= fromClause.length || /\s/.test(fromClause[afterJoin])) {
        segments.push(fromClause.slice(segStart, i));
        segStart = afterJoin;
        continue;
      }
    }
  }

  segments.push(fromClause.slice(segStart));
  return segments.filter((s) => s.trim().length > 0);
}

/**
 * Extracts the unqualified table name from a single table-reference segment
 * such as "`db`.`table` AS alias" or "table t".
 * Returns null if the segment appears to be a subquery.
 */
function parseTableName(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.startsWith("(")) return null;

  // Strip ON ... clause that may appear after the table ref in a JOIN segment
  const onIdx = trimmed.search(/\bON\b/i);
  const ref = onIdx !== -1 ? trimmed.slice(0, onIdx).trim() : trimmed;

  // The first token is the table reference (possibly qualified: db.table)
  const firstToken = ref.split(/\s+/)[0];

  // Strip backticks and take the last qualifier part (after the last dot)
  const parts = firstToken.split(".");
  const lastPart = parts[parts.length - 1];
  return lastPart.replace(/`/g, "");
}

/**
 * Returns true if the SQL query references at least one Langfuse table that
 * has a `project_id` column, meaning the project filter should be injected.
 */
function sqlReferencesProjectTable(sql: string): boolean {
  const tables = extractFromTables(sql);
  if (tables.length === 0) {
    // Could not parse FROM clause — inject conservatively only for known tables.
    // Default to false to avoid injecting on tables without project_id.
    return false;
  }
  return tables.some((t) => LITEFUSE_TABLES_WITH_PROJECT_ID.has(t));
}

/**
 * Finds the character index of a top-level SQL keyword in a query string.
 * "Top-level" means outside any parentheses and string/identifier literals.
 *
 * Supports multi-word keywords like "ORDER BY" and "GROUP BY" where the
 * two parts may be separated by one or more whitespace characters.
 *
 * Returns -1 if the keyword is not found at the top level.
 */
function findTopLevelKeyword(sql: string, keyword: string): number {
  const upper = sql.toUpperCase();
  const kwParts = keyword.trim().toUpperCase().split(/\s+/);

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    if (inSingleQuote) {
      // Handle '' escape sequence inside single-quoted strings
      if (c === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
        i++;
      } else if (c === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (c === '"') inDoubleQuote = false;
      continue;
    }
    if (inBacktick) {
      if (c === "`") inBacktick = false;
      continue;
    }

    if (c === "'") {
      inSingleQuote = true;
      continue;
    }
    if (c === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (c === "`") {
      inBacktick = true;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      continue;
    }

    if (depth !== 0) continue;

    // Require a word boundary before the keyword
    const prevIsWordBoundary = i === 0 || /\s/.test(sql[i - 1]);
    if (!prevIsWordBoundary) continue;

    // Try to match the first part of the keyword
    if (!upper.startsWith(kwParts[0], i)) continue;

    const afterFirst = i + kwParts[0].length;
    if (afterFirst < sql.length && !/\s/.test(sql[afterFirst])) continue;

    if (kwParts.length === 1) {
      return i;
    }

    // Multi-part keyword (ORDER BY, GROUP BY): skip whitespace then match second part
    let j = afterFirst;
    while (j < sql.length && /\s/.test(sql[j])) j++;

    if (!upper.startsWith(kwParts[1], j)) continue;

    const afterSecond = j + kwParts[1].length;
    if (afterSecond < sql.length && !/\s/.test(sql[afterSecond])) continue;

    return i;
  }

  return -1;
}

/**
 * Extracts the inner content and end index of a parenthesized block starting at `start`.
 * `start` must point to the opening `(`.
 * Returns `{ inner, end }` where `inner` is the content between the parens and
 * `end` is the index of the closing `)`. Returns `{ inner: null, end }` if unmatched.
 */
function extractParenContent(
  sql: string,
  start: number,
): { inner: string | null; end: number } {
  let depth = 1;
  let i = start + 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  while (i < sql.length) {
    const c = sql[i];

    if (inSingleQuote) {
      if (c === "'" && i + 1 < sql.length && sql[i + 1] === "'") i++;
      else if (c === "'") inSingleQuote = false;
      i++;
      continue;
    }
    if (inDoubleQuote) {
      if (c === '"') inDoubleQuote = false;
      i++;
      continue;
    }
    if (inBacktick) {
      if (c === "`") inBacktick = false;
      i++;
      continue;
    }
    if (c === "'") {
      inSingleQuote = true;
      i++;
      continue;
    }
    if (c === '"') {
      inDoubleQuote = true;
      i++;
      continue;
    }
    if (c === "`") {
      inBacktick = true;
      i++;
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) {
        return { inner: sql.slice(start + 1, i), end: i };
      }
      i++;
      continue;
    }
    i++;
  }

  return { inner: null, end: i };
}

/**
 * Recursively walks top-level parenthesized blocks in `sql` and replaces any
 * `(SELECT ...)` subquery with its project-id-injected version.
 * Used when the top-level FROM clause has no Langfuse table references (i.e.
 * the query wraps the real table in a derived table / subquery).
 */
function injectIntoSubqueries(sql: string, projectId: string): string {
  let result = "";
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  while (i < sql.length) {
    const c = sql[i];

    if (inSingleQuote) {
      result += c;
      if (c === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
        result += sql[++i];
      } else if (c === "'") {
        inSingleQuote = false;
      }
      i++;
      continue;
    }
    if (inDoubleQuote) {
      result += c;
      if (c === '"') inDoubleQuote = false;
      i++;
      continue;
    }
    if (inBacktick) {
      result += c;
      if (c === "`") inBacktick = false;
      i++;
      continue;
    }
    if (c === "'") {
      inSingleQuote = true;
      result += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDoubleQuote = true;
      result += c;
      i++;
      continue;
    }
    if (c === "`") {
      inBacktick = true;
      result += c;
      i++;
      continue;
    }

    if (c === "(") {
      const { inner, end } = extractParenContent(sql, i);
      if (inner !== null) {
        const trimmedInner = inner.trimStart();
        if (/^SELECT\b/i.test(trimmedInner)) {
          // Recursively inject into the subquery
          const injected = injectProjectIdFilter(trimmedInner, projectId);
          result += "(" + injected + ")";
        } else {
          result += "(" + inner + ")";
        }
        i = end + 1;
        continue;
      }
    }

    result += c;
    i++;
  }

  return result;
}

/**
 * Injects `project_id = '<projectId>'` into a SQL SELECT query's WHERE clause
 * to enforce data isolation per project.
 *
 * Strategy:
 * 1. If the top-level FROM clause references a Langfuse table with project_id,
 *    inject the filter directly into the top-level WHERE clause.
 * 2. Otherwise, recursively walk top-level subqueries and inject into any nested
 *    SELECT that references a Langfuse table (handles derived-table patterns like
 *    `SELECT ... FROM (SELECT ... FROM traces WHERE ...) AS t ...`).
 *
 * Non-SELECT statements (SHOW, USE, DESCRIBE, etc.) are returned unchanged.
 */
export function injectProjectIdFilter(sql: string, projectId: string): string {
  const trimmed = sql.trimStart();
  // Only modify SELECT statements
  if (!/^SELECT\b/i.test(trimmed)) {
    return sql;
  }

  const safeId = projectId.replace(/'/g, "''");
  const filter = `project_id = '${safeId}'`;

  if (sqlReferencesProjectTable(sql)) {
    // Inject at the top level
    const wherePos = findTopLevelKeyword(sql, "WHERE");

    if (wherePos !== -1) {
      const insertAt = wherePos + "WHERE".length;
      return (
        sql.slice(0, insertAt) +
        ` ${filter} AND ` +
        sql.slice(insertAt).replace(/^\s+/, " ")
      );
    }

    // No WHERE found: insert before the first trailing clause or at end
    for (const kw of ["ORDER BY", "GROUP BY", "HAVING", "LIMIT"]) {
      const pos = findTopLevelKeyword(sql, kw);
      if (pos !== -1) {
        return (
          sql.slice(0, pos).trimEnd() + ` WHERE ${filter} ` + sql.slice(pos)
        );
      }
    }

    return sql.trimEnd() + ` WHERE ${filter}`;
  }

  // Top-level FROM has no Langfuse table — try injecting into subqueries
  return injectIntoSubqueries(sql, projectId);
}
