import { renderHook } from "@testing-library/react";

import { EVALUATOR_FIELD_REGISTRY } from "@/src/features/evals/v2/constants/evaluatorSearchRegistry";
import { useSampleObservationFilterOptions } from "./useSampleObservationFilterOptions";

// NOTE (Litefuse): upstream used `vi.hoisted(...)` so the mock could be referenced
// eagerly inside `vi.mock`. jest hoists `jest.mock` above the imports as well, so an
// eager reference here would hit the temporal dead zone. Forwarding the call through
// an arrow keeps the reference lazy, which makes a plain module-scope mock safe.
const useEventsFilterOptionsMock = jest.fn();

jest.mock(
  "../../../../../../../../events/hooks/useEventsFilterOptions",
  () => ({
    useEventsFilterOptions: (...args: unknown[]) =>
      useEventsFilterOptionsMock(...args),
  }),
);

const refiningFilter = [
  {
    column: "environment",
    type: "stringOptions" as const,
    operator: "any of" as const,
    value: ["production"],
  },
];

describe("useSampleObservationFilterOptions", () => {
  beforeEach(() => {
    useEventsFilterOptionsMock.mockReturnValue({
      filterOptions: {
        environment: [{ value: "langfuse-code-eval" }, { value: "production" }],
        traceTags: [{ value: "customer-facing" }],
      },
      isFilterOptionsPending: false,
    });
  });

  it("derives query and builder values from the same filter options", () => {
    const { result } = renderHook(() =>
      useSampleObservationFilterOptions({
        projectId: "project-id",
        startTimeFilter: [],
        refiningFilter,
        filterMode: "builder",
        datasetOptions: [{ id: "dataset-id", name: "Support tickets" }],
        mapObservedOptions: (observed) => observed,
        activeRegistry: EVALUATOR_FIELD_REGISTRY,
      }),
    );

    expect(useEventsFilterOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refiningFilter,
        lazy: false,
        columns: expect.arrayContaining(["environment", "traceTags"]),
      }),
    );
    expect(
      result.current.searchRegistry.fields
        .find((field) => field.id === "datasetName")
        ?.displayValueByFilterValue?.get("dataset-id"),
    ).toBe("Support tickets");
    expect(result.current.observed?.environment).toEqual([
      { value: "production" },
    ]);
    expect(result.current.observed?.datasetName).toEqual([
      { value: "Support tickets" },
    ]);

    expect(
      result.current.builderColumns.find(
        (column) => column.id === "environment",
      ),
    ).toMatchObject({ options: [{ value: "production" }] });
    expect(
      result.current.builderColumns.find((column) => column.id === "tags"),
    ).toMatchObject({ options: [{ value: "customer-facing" }] });
    expect(
      result.current.builderColumns.find(
        (column) => column.id === "experimentDatasetId",
      ),
    ).toMatchObject({
      options: [{ value: "dataset-id", displayValue: "Support tickets" }],
    });
  });
});
