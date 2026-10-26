import type { TracingSearchType } from "@langfuse/shared";

/**
 * ── LITEFUSE NOTE (evaluators v2 migration, upstream copy adapted) ──────────
 * Upstream's search types are `"id" | "content" | "input" | "output"`, where
 * `input` / `output` search only the input or only the output text. Litefuse's
 * Doris search layer does not have that capability: `dorisSearchCondition`
 * (packages/shared/src/server/queries/doris-sql/search.ts) implements exactly two
 * modes, and `content` is always
 *
 *     input MATCH_ALL {phrase} OR output MATCH_ALL {phrase}
 *
 * so there is no per-column full-text search to target. These helpers therefore
 * speak our two-value type. The two upstream MODE strings are still accepted
 * (persisted view state may carry them) but degrade to the combined full-text
 * search instead of turning search off.
 *
 * Open item (待决 1): if Doris ever gains a per-column index, extend
 * `TracingSearchType` and restore the branches.
 * ───────────────────────────────────────────────────────────────────────────
 */

// Helper function to get the current search mode value for the radio group
export function getSearchMode(
  searchType: TracingSearchType[] | undefined,
  tableAllowsFullTextSearch = false,
): string {
  if (!searchType || !tableAllowsFullTextSearch) return "metadata";
  if (searchType.includes("content")) return "metadata_fulltext";
  return "metadata";
}

// Helper function to get the button label based on current search type
export function getSearchButtonLabel(
  searchType: TracingSearchType[] | undefined,
  metadataLabel?: string,
): string {
  if (!searchType) return metadataLabel ?? "IDs / Names";
  if (searchType.includes("content")) return "Full Text: Content";
  return metadataLabel ?? "IDs / Names";
}

export function hasFullTextSearchType(
  searchType: TracingSearchType[] | undefined,
): boolean {
  return Boolean(searchType?.some((type) => type === "content"));
}

// Helper function to convert search mode value to search type array
export function searchModeToType(mode: string): TracingSearchType[] {
  switch (mode) {
    case "metadata_fulltext":
      return ["id", "content"];
    // Upstream's per-column modes: Litefuse has no input-only/output-only search,
    // so they resolve to the combined full-text search (searching more than asked
    // is preferable to silently searching nothing).
    case "metadata_fulltext_input":
    case "metadata_fulltext_output":
      return ["id", "content"];
    default:
      return ["id"];
  }
}
