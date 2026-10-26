/**
 * Parse a Next.js `router.query.timestamp` value into a Date.
 *
 * Returns `undefined` for missing, array, malformed-encoding, or invalid
 * date inputs so callers fall back to the no-timestamp lookup path instead
 * of throwing `URIError` from `decodeURIComponent`.
 *
 * Copied from upstream for the evaluators v2 migration (the copied peek path
 * resolves trace-peek URLs through it; this fork did not have it before).
 */
export function parseTraceTimestampFromQuery(
  timestamp: string | string[] | undefined,
): Date | undefined {
  if (Array.isArray(timestamp)) return undefined;
  if (!timestamp) return undefined;

  try {
    const date = new Date(decodeURIComponent(timestamp));
    return Number.isNaN(date.getTime()) ? undefined : date;
  } catch {
    return undefined;
  }
}
