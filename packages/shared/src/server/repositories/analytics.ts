import {
  queryDoris,
  queryDorisStream,
  commandDoris,
  parseDorisUTCDateTimeFormat,
} from "./doris";

/**
 * Analytics query interface - abstracts between ClickHouse and Doris
 */
export interface AnalyticsQueryOptions {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string>;
}

/**
 * Query analytics backend (Doris only)
 */
export async function queryAnalytics<T>(
  opts: AnalyticsQueryOptions,
): Promise<T[]> {
  return await queryDoris<T>(opts);
}

/**
 * Stream query results from analytics backend
 */
export async function* queryAnalyticsStream<T>(
  opts: AnalyticsQueryOptions,
): AsyncGenerator<T> {
  yield* queryDorisStream<T>(opts);
}

/**
 * Parse date format from analytics backend
 */
export function parseAnalyticsDateTimeFormat(dateString: string): Date {
  return parseDorisUTCDateTimeFormat(dateString);
}

/**
 * Convert Date to analytics backend DateTime format
 */
export function convertDateToAnalyticsDateTime(date: Date): string {
  // Doris stores UTC time
  return date.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Get the current analytics backend name
 */
export function getAnalyticsBackend(): string {
  return "doris";
}

/**
 * Check if current backend is Doris
 */
// export function isDorisBackend(): boolean {
//   return true;
// }

// Doris reserved words that need backtick quoting
const DORIS_RESERVED = new Set([
  "release",
  "public",
  "user",
  "key",
  "value",
  "index",
  "type",
]);

/**
 * Quote a column name for Doris if it's a reserved word.
 * Returns `col` as-is for non-reserved words, or wraps in backticks.
 */
export function dq(col: string): string {
  return DORIS_RESERVED.has(col.toLowerCase()) ? "`" + col + "`" : col;
}
