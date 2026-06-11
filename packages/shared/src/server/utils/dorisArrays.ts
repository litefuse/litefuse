/**
 * Utilities for normalizing Doris ARRAY column values.
 *
 * Doris transmits ARRAY<T> columns over the MySQL protocol as
 * JSON-formatted strings (e.g. '["a","b"]'), not as native arrays —
 * mysql2 does not auto-parse them. Repositories that declare `values:
 * string[]` but read them directly from a Doris ARRAY column will see a
 * string at runtime and crash downstream (`.map is not a function`,
 * `.length` on string, etc).
 *
 * These helpers normalize the value regardless of whether the driver
 * already returned an array or still has a JSON string.
 */

/**
 * Normalize a Doris ARRAY<STRING> (or equivalent) column value to a
 * plain string[]. Empty strings and non-string elements are dropped,
 * because all current callers (trace_ids, user_ids, trace_tags,
 * categorical score values) have no use for them. Malformed JSON or
 * unexpected shapes degrade to [].
 */
export const parseDorisStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
      }
    } catch {
      // fall through
    }
  }
  return [];
};

/**
 * Variant of parseDorisStringArray that preserves order and allows empty
 * strings + nulls. metadata_values can legitimately contain empty strings
 * (a flattened JSON leaf that was "") and must stay length-matched with
 * metadata_names so positional zips stay aligned.
 *
 * Recovery layer: Doris's MySQL-protocol text representation of an
 * ARRAY<String> column does NOT escape inner " characters inside the
 * element string. As a result, values like {"k":"v"} are emitted as
 *   ["a", "{"k":"v"}", "b"]
 * which is invalid JSON — JSON.parse fails. When that happens and the
 * caller can tell us how many elements to expect (parallel-array pair
 * with a clean names array), we fall back to a Doris-quirky scanner that
 * uses `", "` (close-quote, comma, space, open-quote) as the element
 * separator. This is the exact 4-char sequence Doris emits between
 * elements; the space differentiates it from `","` substrings that
 * naturally occur inside JSON-encoded element content. With an expected
 * length we cap the scan at expectedLen-1 separators and treat the rest
 * of the inner text as the last element, so element content containing
 * literal `", "` substrings is recovered correctly as long as it lives
 * in the final element.
 */
const parseDorisStringArrayKeepEmpty = (
  value: unknown,
  expectedLen?: number,
): Array<string | null> => {
  if (Array.isArray(value)) {
    return value.map((v) =>
      typeof v === "string" ? v : v == null ? null : String(v),
    );
  }
  if (typeof value !== "string" || value.length === 0) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((v) =>
        typeof v === "string" ? v : v == null ? null : String(v),
      );
    }
  } catch {
    // Doris quirky text representation — try to recover.
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  if (!inner.startsWith(`"`) || !inner.endsWith(`"`)) return [];

  const SEP = `", "`;
  const elements: string[] = [];
  let start = 1; // skip leading "
  while (true) {
    if (expectedLen !== undefined && elements.length === expectedLen - 1) {
      // Last element: rest of inner up to the trailing "
      elements.push(inner.slice(start, inner.length - 1));
      break;
    }
    const sep = inner.indexOf(SEP, start);
    if (sep === -1) {
      elements.push(inner.slice(start, inner.length - 1));
      break;
    }
    elements.push(inner.slice(start, sep));
    start = sep + SEP.length;
  }
  return elements;
};

/**
 * Reconstruct a Record<string, string> from the parallel arrays that
 * events_full uses to store flattened metadata (metadata_names +
 * metadata_values). Keys with no matching value index get an empty string.
 * Used by repository reads to feed parseMetadataCHRecordToDomain the
 * shape it expects.
 */
export const zipDorisMetadataArrays = (
  names: unknown,
  values: unknown,
): Record<string, string> => {
  const parsedNames = parseDorisStringArray(names);
  // Pass parsedNames.length so the values parser can fall back to the
  // Doris-quirky scanner when JSON.parse fails on inner unescaped quotes.
  const parsedValues = parseDorisStringArrayKeepEmpty(
    values,
    parsedNames.length,
  );
  const out: Record<string, string> = {};
  for (let i = 0; i < parsedNames.length; i++) {
    out[parsedNames[i]] = parsedValues[i] ?? "";
  }
  return out;
};
