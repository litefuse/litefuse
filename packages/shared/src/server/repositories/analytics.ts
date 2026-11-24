import {
  queryDoris,
  queryDorisStream,
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
// Re-exported from the leaf module so every `import … from "./analytics"` site
// keeps working while parameterProcessor imports the leaf directly (breaks the
// analytics ↔ doris ↔ parameterProcessor require cycle).
export { convertDateToAnalyticsDateTime } from "./analyticsDateTime";

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

// dq moved to the analyticsDateTime leaf (module-init callers must not trigger
// analytics's own require cycle) — re-exported so `import { dq } from "./analytics"`
// still resolves for non-module-init callers.
export { dq } from "./analyticsDateTime";
