import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { FilterState } from "@langfuse/shared";

import type { FieldRegistry } from "@/src/features/search-bar";
import type { AbsoluteTimeRange } from "@/src/utils/date-range-utils";
import { compactNumberFormatter } from "@/src/utils/numbers";
import {
  SampleObservationSelectorBase,
  type SampleObservation,
} from "@/src/features/evals/v2/components/Evaluators/Testing/components/SampleObservationSelectorBase/SampleObservationSelectorBase";

function toEventsPreviewFilters(filters: FilterState): FilterState {
  return filters.map((filter) =>
    filter.column === "tags" ? { ...filter, column: "traceTags" } : filter,
  ) as FilterState;
}

const addRuleTagAlias: Parameters<
  typeof SampleObservationSelectorBase
>[0]["mapObservedOptions"] = (observed) =>
  observed === undefined
    ? undefined
    : { ...observed, tags: observed.traceTags ?? [] };

const resolveSelection: Parameters<
  typeof SampleObservationSelectorBase
>[0]["resolveSelection"] = (observations, selectedObservationId) => {
  const firstMatchingObservation = observations[0] ?? null;
  return selectedObservationId !== firstMatchingObservation?.id
    ? firstMatchingObservation
    : undefined;
};

export function RuleSampleObservationSelector({
  projectId,
  timeRange,
  filterState,
  onFilterStateChange,
  tableName,
  registry,
  selectedObservationId,
  onSelect,
  onOpenTrace,
}: {
  projectId: string;
  timeRange: AbsoluteTimeRange | null;
  filterState: FilterState;
  onFilterStateChange: (filters: FilterState) => void;
  tableName: string;
  registry: FieldRegistry;
  selectedObservationId: string | null;
  onSelect: (observation: SampleObservation | null) => void;
  onOpenTrace: (observation: SampleObservation) => void;
}) {
  const { t } = useTranslation();
  const previewFilters = useMemo(
    () => toEventsPreviewFilters(filterState),
    [filterState],
  );

  return (
    <SampleObservationSelectorBase
      projectId={projectId}
      timeRange={timeRange}
      filterState={filterState}
      onFilterStateChange={onFilterStateChange}
      previewFilters={previewFilters}
      tableName={tableName}
      registry={registry}
      selectedObservationId={selectedObservationId}
      onSelect={onSelect}
      onOpenTrace={onOpenTrace}
      leadingColumns={[]}
      resolveSelection={resolveSelection}
      getRowClassName={undefined}
      filterDescription={t(
        "Define which incoming observations match this rule.",
      )}
      filterTooltip={t(
        "Only new observations matching these filters are evaluated by this rule.",
      )}
      matchingDescription={t(
        "The first match is used to preview attached evaluator mappings.",
      )}
      matchingTooltip={t(
        "Observations matching the rule filters over the last seven days.",
      )}
      formatCount={(count) =>
        count === 1
          ? t("({{total}} match)", { total: compactNumberFormatter(count) })
          : t("({{total}} matches)", { total: compactNumberFormatter(count) })
      }
      mapObservedOptions={addRuleTagAlias}
    />
  );
}
