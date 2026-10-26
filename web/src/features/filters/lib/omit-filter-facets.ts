import type { FilterConfig } from "./filter-config";

/**
 * Returns a copy of `config` with the given columns removed from its facets, so a
 * surface that already bounds a column (a user-detail traces table) offers no
 * facet for it.
 *
 * // LITEFUSE NOTE: differs from upstream (which lives in lib/filter-config.ts).
//
// Upstream's version also records the omitted columns on
// `FilterConfig.omittedFilterColumns`, so the sidebar never silently applies a
// filter it cannot display (LFE-14824). Our older `FilterConfig` has no such
// field, and nothing in our tree reads it, so that bookkeeping is left out here
// instead of editing the shared filter type. Flagged for step-3 reconciliation.
 */
export function omitFilterFacets(
  config: FilterConfig,
  omittedColumns: string[],
): FilterConfig {
  if (omittedColumns.length === 0) {
    return config;
  }

  const omittedColumnSet = new Set(omittedColumns);

  return {
    ...config,
    defaultExpanded: config.defaultExpanded?.filter(
      (column) => !omittedColumnSet.has(column),
    ),
    facets: config.facets.filter(
      (facet) => !omittedColumnSet.has(facet.column),
    ),
  };
}
