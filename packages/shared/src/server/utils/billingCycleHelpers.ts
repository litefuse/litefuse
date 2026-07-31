import { getDaysInMonth, subMonths } from "date-fns";
import type { Organization } from "@prisma/client";

type BillingCycleSource = Pick<
  Organization,
  "cloudBillingCycleAnchor" | "createdAt"
>;

/**
 * Start of day in UTC (00:00:00.000Z)
 */
export function startOfDayUTC(date: Date): Date {
  const d = new Date(date);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/**
 * End of day in UTC (23:59:59.999Z)
 */
export function endOfDayUTC(date: Date): Date {
  const d = new Date(date);
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

/**
 * Get the exact billing cycle anchor with fallback to createdAt.
 */
export function getBillingCycleAnchor(org: BillingCycleSource): Date {
  return new Date(org.cloudBillingCycleAnchor ?? org.createdAt);
}

function cycleOccurrence(params: {
  anchor: Date;
  year: number;
  month: number;
}): Date {
  const normalizedMonth = new Date(Date.UTC(params.year, params.month, 1));
  const daysInTargetMonth = getDaysInMonth(normalizedMonth);
  return new Date(
    Date.UTC(
      normalizedMonth.getUTCFullYear(),
      normalizedMonth.getUTCMonth(),
      Math.min(params.anchor.getUTCDate(), daysInTargetMonth),
      params.anchor.getUTCHours(),
      params.anchor.getUTCMinutes(),
      params.anchor.getUTCSeconds(),
      params.anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * Calculate the billing cycle start date for the billing cycle containing the reference date
 * Handles month boundaries correctly (e.g., 31st → 28/29/30 for shorter months)
 *
 * Returns the most recent occurrence of the billing cycle day that is on or before the reference date
 *
 * Example: If anchor is Jan 31 and reference is Feb 15:
 * - Feb cycle day would be Feb 29 (adjusted from 31 due to leap year)
 * - Since Feb 15 < Feb 29, we're still in Jan's cycle → return Jan 31
 *
 * Example: If anchor is Jan 15 and reference is Feb 20:
 * - Feb cycle day is Feb 15
 * - Since Feb 20 >= Feb 15, we're in Feb's cycle → return Feb 15
 */
export function getBillingCycleStart(
  org: BillingCycleSource,
  referenceDate: Date,
): Date {
  const anchor = getBillingCycleAnchor(org);

  // Get reference month/year in UTC
  const refYear = referenceDate.getUTCFullYear();
  const refMonth = referenceDate.getUTCMonth();

  const currentMonthCycleStart = cycleOccurrence({
    anchor,
    year: refYear,
    month: refMonth,
  });

  // If current month's cycle start is after reference date, use previous month
  if (currentMonthCycleStart > referenceDate) {
    return cycleOccurrence({
      anchor,
      year: refYear,
      month: refMonth - 1,
    });
  }

  return currentMonthCycleStart;
}

/**
 * Calculate the billing cycle end date (when the usage limit resets)
 *
 * Returns the start of the next billing cycle, which is when the current cycle ends
 * and usage is reset.
 *
 * Example: If anchor is Jan 15 and reference is Jan 20:
 * - Current cycle start: Jan 15
 * - Next cycle start (reset date): Feb 15
 *
 * Handles month boundaries correctly (e.g., 31st → 28/29/30 for shorter months)
 *
 * @param org - Organization with billing cycle anchor
 * @param referenceDate - The current date (typically "now")
 * @returns Date when the usage limit resets (start of next billing cycle)
 */
export function getBillingCycleEnd(
  org: BillingCycleSource,
  referenceDate: Date,
): Date {
  // Get the current cycle start using existing function
  const currentCycleStart = getBillingCycleStart(org, referenceDate);
  const anchor = getBillingCycleAnchor(org);
  return cycleOccurrence({
    anchor,
    year: currentCycleStart.getUTCFullYear(),
    month: currentCycleStart.getUTCMonth() + 1,
  });
}

export function getBillingCycleBoundaries(
  org: BillingCycleSource,
  start: Date,
  end: Date,
): Date[] {
  if (start >= end) return [];

  const boundaries: Date[] = [];
  let boundary = getBillingCycleEnd(org, start);
  while (boundary < end) {
    if (boundary > start) boundaries.push(boundary);
    boundary = getBillingCycleEnd(org, new Date(boundary.getTime() + 1));
  }
  return boundaries;
}

/**
 * Calculate the maximum number of days to look back for a billing cycle
 *
 * Returns the number of days in the previous month relative to the reference date.
 * This ensures we capture a full billing cycle when processing usage.
 *
 * Examples:
 * - Reference date: March 15, 2024 → Look back 29 days (Feb has 29 days in 2024)
 * - Reference date: April 15, 2024 → Look back 31 days (March has 31 days)
 * - Reference date: May 15, 2024 → Look back 30 days (April has 30 days)
 *
 * @param referenceDate - The current date (typically "now")
 * @returns Number of days to look back to cover the full billing cycle
 */
export function getDaysToLookBack(referenceDate: Date): number {
  const refYear = referenceDate.getUTCFullYear();
  const refMonth = referenceDate.getUTCMonth();

  // Get the previous month
  const prevMonthDate = subMonths(new Date(Date.UTC(refYear, refMonth, 1)), 1);

  // Return the number of days in the previous month
  return getDaysInMonth(prevMonthDate);
}
