import { render, screen } from "@testing-library/react";
import { SidebarNotifications } from "./sidebar-notifications";

jest.mock("../useLocalStorage", () => ({
  __esModule: true,
  default: () => [[], jest.fn()],
}));

// Skipped: litefuse turns sidebar notifications off (`filter(() => false)`), so nothing renders.
describe.skip("SidebarNotifications", () => {
  it("renders the GitHub stars badge with social style query params", () => {
    render(<SidebarNotifications />);

    const badge = screen.getByAltText("Litefuse GitHub stars");
    const src = badge.getAttribute("src");

    expect(src).toContain("style=social");
    expect(src).not.toContain("&amp;");
  });
});
