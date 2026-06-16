import { TracingSearchType } from "../../../interfaces/search";

export interface DorisSearchResult {
  query: string;
  params: Record<string, unknown>;
}

export interface DorisSearchContext {
  /** 查询上下文类型：traces 或 observations */
  type: "traces" | "observations";
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

  // 使用参数化查询来避免双重转义问题
  const searchParam = `%${query}%`;

  const conditions = [];

  // ID search. For obs context, we COALESCE the denormalised obs row value
  // with the trace span value so the search hits even when an obs landed
  // before its trace (denormalised field still empty).
  if (!searchType || searchType.includes("id")) {
    if (context?.type === "observations") {
      conditions.push(
        `o.span_id LIKE {searchQuery: String} OR o.name LIKE {searchQuery: String} OR COALESCE(NULLIF(o.user_id, ''), t.user_id) LIKE {searchQuery: String}`,
      );
    } else {
      conditions.push(
        `t.trace_id LIKE {searchQuery: String} OR t.user_id LIKE {searchQuery: String} OR t.name LIKE {searchQuery: String}`,
      );
    }
  }

  // 内容搜索：主要针对 observations 表
  if (searchType && searchType.includes("content")) {
    if (context?.type === "observations") {
      conditions.push(
        `o.input LIKE {searchQuery: String} OR o.output LIKE {searchQuery: String}`,
      );
    } else {
      // traces 查询中通常不搜索 input/output，但如果需要可以连接 observations 表
      conditions.push(
        `input LIKE {searchQuery: String} OR output LIKE {searchQuery: String}`,
      );
    }
  }

  return {
    query: conditions.length > 0 ? `AND (${conditions.join(" OR ")})` : "",
    params: {
      searchQuery: searchParam,
    },
  };
};
