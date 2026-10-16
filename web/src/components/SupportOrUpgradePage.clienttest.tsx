import { render, screen } from "@testing-library/react";
import { SupportOrUpgradePage } from "./SupportOrUpgradePage";

/**
 * Characterisation test: pins the *behaviour* of the restriction placeholder —
 * what a user can read on screen — without pinning implementation details such
 * as class names or component composition, so the implementation stays free to
 * be rewritten while behaviour cannot drift.
 */
describe("SupportOrUpgradePage", () => {
  it("states the restriction and who to ask for access", () => {
    render(<SupportOrUpgradePage />);

    expect(screen.getByText("Access Restricted")).toBeTruthy();
    expect(
      screen.getByText("This feature requires additional permissions"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Contact your system/project administrator for access. Need help? Reach out to support.",
      ),
    ).toBeTruthy();
  });

  it("offers no action of its own", () => {
    render(<SupportOrUpgradePage />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
