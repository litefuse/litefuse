import {
  processNavigation,
  type NavigationItem,
} from "@/src/components/layouts/utilities/routes";
import {
  RouteGroup,
  RouteSection,
  type Route,
} from "@/src/components/layouts/routes";

const toNavItem = (route: Route): NavigationItem => ({
  ...route,
  url: route.pathname,
  isActive: false,
  items: route.items?.map(toNavItem),
});

describe("processNavigation", () => {
  it("includes logging under the observability group in main navigation", () => {
    const { mainNavigation } = processNavigation(toNavItem);

    expect(mainNavigation.grouped?.[RouteGroup.Observability]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Logging",
          section: RouteSection.Main,
          group: RouteGroup.Observability,
          url: "/project/[projectId]/logging",
        }),
      ]),
    );
  });
});
