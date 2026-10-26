import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { RulesOverviewSelectionBarView } from "./RulesOverviewSelectionBarView";

function renderBar(hasWriteAccess: boolean) {
  return render(
    <RulesOverviewSelectionBarView
      selectedCount={2}
      hasWriteAccess={hasWriteAccess}
      statusChangePending={false}
      deletePending={false}
      deleteDialogOpen={false}
      onClear={jest.fn()}
      onEnable={jest.fn()}
      onDisable={jest.fn()}
      onDelete={jest.fn()}
      onDeleteDialogOpenChange={jest.fn()}
      onConfirmDelete={jest.fn()}
    />,
  );
}

describe("RulesOverviewSelectionBarView", () => {
  // Selecting rows is a read gesture; a read-only role can select but must not
  // be offered a bulk write it cannot perform.
  it("offers no bulk write actions to roles without evaluationRule:CUD", () => {
    renderBar(false);

    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear selection" }),
    ).toBeInTheDocument();
  });

  it("offers the bulk write actions to roles with evaluationRule:CUD", () => {
    renderBar(true);

    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
