/**
 * Doris time bucketing utilities for score analytics
 *
 * This module provides helper functions for constructing Doris time-based queries
 * with proper interval normalization and SQL function generation.
 */

import { type IntervalConfig } from "@/src/utils/date-range-utils";

/**
 * Normalize multi-unit intervals to single-unit intervals for Doris
 *
 * Doris date_trunc function works best with single-unit intervals.
 * This function normalizes multi-unit intervals to single-unit equivalents,
 * with special handling for 7-day intervals (ISO 8601 weeks).
 *
 * Special cases:
 * - 7-day intervals remain as {count: 7, unit: "day"} to use date_trunc with 'week'
 * - All other intervals normalize to {count: 1, unit: originalUnit}
 *
 * This approach ensures consistent, calendar-aligned behavior across all time ranges.
 *
 * @param interval - The requested interval (may be multi-unit like {count: 2, unit: "day"})
 * @returns Normalized single-unit interval for Doris (e.g., {count: 1, unit: "day"})
 *
 * @example
 * ```typescript
 * normalizeIntervalForDoris({ count: 7, unit: "day" })
 * // Returns: { count: 7, unit: "day" } (special case for weeks)
 *
 * normalizeIntervalForDoris({ count: 2, unit: "day" })
 * // Returns: { count: 1, unit: "day" }
 *
 * normalizeIntervalForDoris({ count: 1, unit: "hour" })
 * // Returns: { count: 1, unit: "hour" }
 * ```
 */
export const normalizeIntervalForDoris = (
  interval: IntervalConfig,
): IntervalConfig => {
  // Special case: 7-day intervals become ISO 8601 weeks (Monday-aligned)
  if (interval.count === 7 && interval.unit === "day") {
    return { count: 7, unit: "day" }; // Will use date_trunc with 'week'
  }

  // All other intervals: normalize to single-unit
  return { count: 1, unit: interval.unit };
};

/**
 * Generate Doris SQL function for time bucketing
 *
 * Returns the appropriate Doris date_trunc function for SINGLE-UNIT intervals.
 * Uses calendar-aligned functions to ensure "today's" data appears in today's bucket.
 *
 * Special cases:
 * - 7-day intervals use date_trunc with 'week' (Monday start, ISO 8601)
 * - All other intervals use date_trunc with the appropriate unit
 *
 * @param timestampField - The timestamp field name to bucket (e.g., "timestamp", "timestamp1")
 * @param normalizedInterval - Single-unit interval (or 7-day for weeks)
 * @returns Doris SQL function call as string
 *
 * @example
 * ```typescript
 * getDorisTimeBucketFunction("timestamp", { count: 1, unit: "day" })
 * // Returns: "date_trunc(timestamp, 'day')"
 *
 * getDorisTimeBucketFunction("timestamp", { count: 7, unit: "day" })
 * // Returns: "date_trunc(timestamp, 'week')"
 *
 * getDorisTimeBucketFunction("created_at", { count: 1, unit: "hour" })
 * // Returns: "date_trunc(created_at, 'hour')"
 * ```
 */
export const getDorisTimeBucketFunction = (
  timestampField: string,
  normalizedInterval: IntervalConfig,
): string => {
  const { count, unit } = normalizedInterval;

  // Special case: 7-day intervals align to ISO 8601 week (Monday start)
  if (count === 7 && unit === "day") {
    return `date_trunc(${timestampField}, 'week')`;
  }

  // All other cases are single-unit intervals with calendar alignment
  switch (unit) {
    case "second":
      return `date_trunc(${timestampField}, 'second')`;
    case "minute":
      return `date_trunc(${timestampField}, 'minute')`;
    case "hour":
      return `date_trunc(${timestampField}, 'hour')`;
    case "day":
      return `date_trunc(${timestampField}, 'day')`;
    case "month":
      return `date_trunc(${timestampField}, 'month')`;
    case "year":
      return `date_trunc(${timestampField}, 'year')`;
  }
};
