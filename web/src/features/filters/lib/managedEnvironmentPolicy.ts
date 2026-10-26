import type { FilterState } from "@langfuse/shared";
import { computeSelectedValues } from "./filter-query-encoding";
import { areStringSetsEqual } from "./stringSetUtils";

type EnvironmentFilter = Extract<
  FilterState[number],
  { type: "stringOptions" }
>;

export type ManagedEnvironmentPolicyInput = {
  hiddenEnvironments?: readonly string[];
  managedEnvironmentColumn?: string;
};

export type ManagedEnvironmentPolicyConfig = {
  hiddenEnvironments: string[];
  managedEnvironmentColumn: string;
};

export function buildManagedEnvironmentPolicyConfig(
  input?: ManagedEnvironmentPolicyInput,
): ManagedEnvironmentPolicyConfig {
  return {
    managedEnvironmentColumn: input?.managedEnvironmentColumn ?? "environment",
    hiddenEnvironments: Array.from(new Set(input?.hiddenEnvironments ?? [])),
  };
}

function isEquivalentToImplicitEnvironmentDefault(params: {
  envFilter: EnvironmentFilter;
  hiddenEnvironments: string[];
  availableEnvironmentValues: string[];
}): boolean {
  const { envFilter, hiddenEnvironments, availableEnvironmentValues } = params;

  if (hiddenEnvironments.length === 0) return false;

  const exactDefaultMatch =
    envFilter.operator === "none of" &&
    areStringSetsEqual(envFilter.value, hiddenEnvironments);

  if (exactDefaultMatch) return true;

  if (availableEnvironmentValues.length === 0) return false;

  const selectedFromFilter = computeSelectedValues(
    availableEnvironmentValues,
    envFilter,
  );
  const hiddenSet = new Set(hiddenEnvironments);
  const selectedFromDefault = availableEnvironmentValues.filter(
    (value) => !hiddenSet.has(value),
  );

  return areStringSetsEqual(selectedFromFilter, selectedFromDefault);
}

export function stripImplicitEnvironmentFilterFromExplicitState(params: {
  explicitFilters: FilterState;
  availableEnvironmentValues: string[];
  config: ManagedEnvironmentPolicyConfig;
}): FilterState {
  const { explicitFilters, availableEnvironmentValues, config } = params;
  const { managedEnvironmentColumn, hiddenEnvironments } = config;

  if (hiddenEnvironments.length === 0) return explicitFilters;

  const managedColumnFilters = explicitFilters.filter(
    (filter) => filter.column === managedEnvironmentColumn,
  );

  // Only canonicalize the standard environment checkbox filter shape.
  if (
    managedColumnFilters.length !== 1 ||
    managedColumnFilters[0]?.type !== "stringOptions"
  ) {
    return explicitFilters;
  }

  const envFilter = managedColumnFilters[0] as EnvironmentFilter;
  const otherFilters = explicitFilters.filter((filter) => filter !== envFilter);

  if (
    isEquivalentToImplicitEnvironmentDefault({
      envFilter,
      hiddenEnvironments,
      availableEnvironmentValues,
    })
  ) {
    return otherFilters;
  }
  return explicitFilters;
}

export function buildImplicitEnvironmentFilter(params: {
  explicitFilters: FilterState;
  config: ManagedEnvironmentPolicyConfig;
}): FilterState {
  const { explicitFilters, config } = params;
  const { managedEnvironmentColumn, hiddenEnvironments } = config;

  if (hiddenEnvironments.length === 0) return [];

  const hasExplicitEnvironmentFilter = explicitFilters.some(
    (filter) => filter.column === managedEnvironmentColumn,
  );

  if (hasExplicitEnvironmentFilter) return [];

  return [
    {
      column: managedEnvironmentColumn,
      type: "stringOptions" as const,
      operator: "none of" as const,
      value: hiddenEnvironments,
    },
  ];
}

export function buildEffectiveEnvironmentFilter(params: {
  explicitFilters: FilterState;
  config: ManagedEnvironmentPolicyConfig;
}): FilterState {
  const { explicitFilters, config } = params;
  const { managedEnvironmentColumn } = config;

  const managedColumnFilters = explicitFilters.filter(
    (filter) => filter.column === managedEnvironmentColumn,
  );

  if (managedColumnFilters.length === 0) {
    return buildImplicitEnvironmentFilter({
      explicitFilters,
      config,
    });
  }

  if (
    managedColumnFilters.length !== 1 ||
    managedColumnFilters[0]?.type !== "stringOptions"
  ) {
    return managedColumnFilters;
  }

  const envFilter = managedColumnFilters[0] as EnvironmentFilter;
  return [envFilter];
}

// ── Added for the evaluators v2 migration (ported from upstream) ─────────────
/**
 * Splits a `none of [...]` environment selection into the values the user really
 * picked and the hidden ones the policy contributed, and reports whether the
 * selection excludes every hidden environment (i.e. it is the implicit default).
 */
export function partitionNoneOfEnvironmentValues(params: {
  values: readonly string[];
  hiddenEnvironments: readonly string[];
}): {
  extras: string[];
  hiddenInValues: string[];
  excludesAllHidden: boolean;
} {
  const { values, hiddenEnvironments } = params;
  const hiddenSet = new Set(hiddenEnvironments);
  const extras = values.filter((value) => !hiddenSet.has(value));
  const hiddenInValues = values.filter((value) => hiddenSet.has(value));
  const valueSet = new Set(values);

  return {
    extras,
    hiddenInValues,
    excludesAllHidden:
      hiddenEnvironments.length > 0 &&
      hiddenEnvironments.every((environment) => valueSet.has(environment)),
  };
}

/**
 * The search bar reads the user's own selection: an implicit
 * `none of [hidden ∪ extras]` exclusion is shown as just
 * `-environment:production`, so the hidden environments stay off the chip.
 */
export function toSearchBarEnvironmentFilters(params: {
  explicitFilters: FilterState;
  config: ManagedEnvironmentPolicyConfig;
}): FilterState {
  const { explicitFilters, config } = params;
  const { managedEnvironmentColumn, hiddenEnvironments } = config;

  if (hiddenEnvironments.length === 0) return explicitFilters;

  const managedColumnFilters = explicitFilters.filter(
    (filter) => filter.column === managedEnvironmentColumn,
  );

  if (
    managedColumnFilters.length !== 1 ||
    managedColumnFilters[0]?.type !== "stringOptions"
  ) {
    return explicitFilters;
  }

  const envFilter = managedColumnFilters[0] as EnvironmentFilter;
  if (envFilter.operator !== "none of") {
    return explicitFilters;
  }

  const { extras, excludesAllHidden } = partitionNoneOfEnvironmentValues({
    values: envFilter.value,
    hiddenEnvironments,
  });

  if (!excludesAllHidden) {
    return explicitFilters;
  }

  return explicitFilters.flatMap((filter) => {
    if (filter !== envFilter) return [filter];
    if (extras.length === 0) return [];
    return [{ ...envFilter, value: extras }];
  });
}
