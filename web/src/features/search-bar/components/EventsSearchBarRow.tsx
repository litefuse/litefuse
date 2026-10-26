/* eslint-disable @repo/no-style-props */
// Search-bar row: the query composer at full width.
//
// ── LITEFUSE NOTE (this file differs from upstream) ──────────────────────────
// Upstream's row also offers an "Ask AI" sub-mode: it swaps the grammar composer
// for a natural-language prompt (components/SearchBarAiPrompt.tsx) and calls the
// `searchBar.generateFilter` tRPC route (features/search-bar/server/*).
//
// Litefuse does not ship in-app AI: the feature is parked pending a full review
// (搁置，待整体评估). When this
// module was copied, the AI sub-mode, its server router, and the org-level
// `aiFeaturesEnabled` lookup it needed (`useQueryProject`) were deliberately
// left out. Everything else below is upstream's code.
//
// Some props stay in the type but are unused, purely so upstream call sites in
// `features/evals/v2/**` keep compiling unchanged: `aiDataContext`,
// `aiScoreNames`, `onApplyFilters`, `tableName`, `isV4`.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";

import { type FilterState } from "@langfuse/shared";
import { cn } from "@/src/utils/tailwind";
import type {
  ObservedOptions,
  ObservedScoreNames,
} from "@/src/features/search-bar/lib/observed-options";
import {
  EVENTS_FIELD_REGISTRY,
  type FieldRegistry,
} from "@/src/features/search-bar/lib/fields";
import { ComposerWithPreview } from "@/src/features/search-bar/components/ComposerWithPreview";
import { SearchBarStoreProvider } from "@/src/features/search-bar/store/SearchBarStoreProvider";
import type { SearchBarStore } from "@/src/features/search-bar/store/searchBarStore";
import type { SearchCommit } from "@/src/features/search-bar/hooks/useEventsSearchBar";
import type { QueryPresetSection } from "@/src/features/search-bar/lib/completions";

type EventsSearchBarRowProps = {
  projectId?: string;
  /** Table this bar filters — threaded to AI-prompt analytics upstream. */
  tableName: string;
  isV4?: boolean;
  store: SearchBarStore;
  commit: SearchCommit;
  observed: ObservedOptions | undefined;
  /** Columns whose lazy fetch terminally errored — value-stage loading settles to
   *  empty (per column) instead of pinning, matching the sidebar's settled-error
   *  state, without blocking other columns. */
  erroredColumns?: ReadonlySet<string>;
  /** Given a filter token's field, the reason it is not applied on the current
   *  surface (e.g. the chart view can't filter on it) — dims the pill + hover.
   *  Undefined leaves all filters active. */
  fieldReason?: (field: string) => string | null;
  /** Reason free-text tokens are not applied on the current surface, or null. */
  freeTextReason?: string | null;
  /** Applies AI-generated filters (apply-immediately). Unused in Litefuse: kept
   *  so upstream call sites typecheck. */
  onApplyFilters: (filters: FilterState) => void;
  /** Lazy filter-options: widen the requested column set on demand. Threaded to
   *  the composer (request a field's values when typed). */
  onRequestColumns?: (columns: readonly string[]) => void;
  /** Complete queries supplied by the host view. */
  presetSections?: QueryPresetSection[];
  onQueryPresetPick?: (presetId: string) => void;
  /** Project data context for the AI prompt. Unused in Litefuse: kept so
   *  upstream call sites typecheck. */
  aiDataContext?: string;
  /** Observed score names for the AI prompt's score-name validation. Unused in
   *  Litefuse: kept so upstream call sites typecheck. */
  aiScoreNames?: ObservedScoreNames;
  /** Overrides the wrapper spacing. The default (`px-2 pt-2 pb-1`) aligns the
   *  bar with the desktop toolbar row; the mobile Filters sheet passes flush
   *  padding so the bar lines up with the sheet's other sections. */
  className?: string;
  /** The view-specific grammar and filter contract. */
  registry?: FieldRegistry;
};

export function EventsSearchBarRow({
  projectId,
  store,
  commit,
  observed,
  erroredColumns,
  fieldReason,
  freeTextReason,
  onRequestColumns,
  presetSections,
  onQueryPresetPick,
  className,
  registry = EVENTS_FIELD_REGISTRY,
}: EventsSearchBarRowProps) {
  return (
    <div className={cn("min-w-0 px-2 pt-2 pb-1", className)}>
      <SearchBarStoreProvider store={store} commit={commit}>
        <ComposerWithPreview
          projectId={projectId}
          observed={observed}
          erroredColumns={erroredColumns}
          fieldReason={fieldReason}
          freeTextReason={freeTextReason}
          onRequestColumns={onRequestColumns}
          presetSections={presetSections}
          onQueryPresetPick={onQueryPresetPick}
          registry={registry}
        />
      </SearchBarStoreProvider>
    </div>
  );
}
