import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ColumnDefinition, FilterState } from "@langfuse/shared";

import { ObservationFilterBuilder } from "./ObservationFilterBuilder";

let containerWidth = 560;

// NOTE (Litefuse): jest.mock() specifiers must be relative here. The `@/` alias is
// only rewritten by the SWC transform inside import/export statements, so a bare
// `@/...` string argument reaches jest's resolver verbatim and fails with
// "Cannot find module" (jest.config.mjs has no `@/` moduleNameMapper entry).
jest.mock("../../../../../../../../../../hooks/useElementSize", () => ({
  useElementSize: () => [
    { current: null },
    { width: containerWidth, height: 200 },
  ],
}));

const columns: ColumnDefinition[] = [
  {
    id: "environment",
    name: "Environment",
    type: "stringOptions",
    internal: "environment",
    options: [{ value: "production" }],
  },
];

const filterState: FilterState = [
  {
    column: "environment",
    type: "stringOptions",
    operator: "any of",
    value: ["production"],
  },
];

const renderBuilder = () =>
  render(
    <ObservationFilterBuilder
      columns={columns}
      filterState={filterState}
      onChange={jest.fn()}
      queryOnlyColumnIds={[]}
    />,
  );

describe("ObservationFilterBuilder", () => {
  beforeEach(() => {
    containerWidth = 560;
  });

  it("keeps the table layout when space is limited", () => {
    renderBuilder();

    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("wraps into the compact row layout when space is too narrow", () => {
    containerWidth = 420;
    renderBuilder();

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Where")).toBeInTheDocument();
  });
});
