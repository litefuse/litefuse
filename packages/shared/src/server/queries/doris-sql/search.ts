import { TracingSearchType } from "../../../interfaces/search";

export interface DorisSearchResult {
  query: string;
  params: Record<string, unknown>;
}

export interface DorisSearchContext {
  /** Query context type: traces or observations */
  type: "traces" | "observations";
  /** Whether the query joins the traces table */
  hasTracesJoin?: boolean;
}

/**
 * Generate Doris-compatible search conditions
 * Adapted for Doris syntax
 * @param query - Search query string
 * @param searchType - Types of search to perform
 * @param context - Context information for determining correct table prefixes
 */
export const dorisSearchCondition = (
  query?: string,
  searchType?: TracingSearchType[],
  context?: DorisSearchContext,
): DorisSearchResult => {
  if (!query) {
    return {
      query: "",
      params: {},
    };
  }

  // ID search uses a parameterized LIKE (substring match)
  const searchParam = `%${query}%`;

  const conditions = [];

  // ID search: column prefixes depend on the query context
  if (!searchType || searchType.includes("id")) {
    if (context?.type === "observations") {
      // observations context: in events_full the observation identifier column
      // is span_id (there is no `id` column).
      conditions.push(
        context.hasTracesJoin
          ? `o.span_id LIKE {searchQuery: String} OR o.name LIKE {searchQuery: String} OR t.user_id LIKE {searchQuery: String}`
          : `o.span_id LIKE {searchQuery: String} OR o.name LIKE {searchQuery: String}`,
      );
    } else {
      // traces context (default): events_full uses trace_id as the trace
      // identifier, and the trace name lives in trace_name (not the root span name).
      conditions.push(
        `t.trace_id LIKE {searchQuery: String} OR t.user_id LIKE {searchQuery: String} OR t.trace_name LIKE {searchQuery: String}`,
      );
    }
  }

  // Content search: input/output use the unicode inverted index + MATCH_PHRASE
  // (phrase / substring semantics, see migration 0037). An empty or
  // punctuation-only query does not error, it just matches nothing, so no extra
  // guard is needed.
  if (searchType && searchType.includes("content")) {
    if (context?.type === "observations") {
      conditions.push(
        `o.input MATCH_PHRASE {searchPhrase: String} OR o.output MATCH_PHRASE {searchPhrase: String}`,
      );
    } else {
      // traces queries usually don't search input/output, but it's supported
      // here if the query joins the observations rows.
      conditions.push(
        `input MATCH_PHRASE {searchPhrase: String} OR output MATCH_PHRASE {searchPhrase: String}`,
      );
    }
  }

  const params: Record<string, unknown> = {
    searchQuery: searchParam,
  };
  // MATCH_PHRASE takes the bare term (no % wildcards).
  if (searchType?.includes("content")) {
    params.searchPhrase = query;
  }

  return {
    query: conditions.length > 0 ? `AND (${conditions.join(" OR ")})` : "",
    params,
  };
};
