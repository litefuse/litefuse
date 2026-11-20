import managedDashboards from "../../../../../worker/src/constants/langfuse-dashboards.json";
import { createI18nInstance } from "@/src/features/i18n/instance";
import { translateManagedDashboardText } from "./managed-dashboard-text";

describe("managed dashboard translations", () => {
  it.each(["dashboards", "widgets"] as const)(
    "translates every seeded %s name and description into Chinese",
    (kind) => {
      const i18n = createI18nInstance("zh-CN");
      const untranslated = managedDashboards[kind].flatMap((item) =>
        [item.name, item.description].filter(
          (text) =>
            translateManagedDashboardText(text, "LANGFUSE", i18n.t) === text,
        ),
      );

      expect(untranslated).toEqual([]);
    },
  );

  it("preserves the original English names and descriptions", () => {
    const i18n = createI18nInstance("en");
    const items = [
      ...managedDashboards.dashboards,
      ...managedDashboards.widgets,
    ];

    for (const item of items) {
      expect(translateManagedDashboardText(item.name, "LANGFUSE", i18n.t)).toBe(
        item.name,
      );
      expect(
        translateManagedDashboardText(item.description, "LANGFUSE", i18n.t),
      ).toBe(item.description);
    }
  });

  it("preserves project-owned content even when it matches a managed translation", () => {
    const i18n = createI18nInstance("zh-CN");
    for (const item of [
      ...managedDashboards.dashboards,
      ...managedDashboards.widgets,
    ]) {
      expect(translateManagedDashboardText(item.name, "PROJECT", i18n.t)).toBe(
        item.name,
      );
      expect(
        translateManagedDashboardText(item.description, "PROJECT", i18n.t),
      ).toBe(item.description);
    }
  });

  it("leaves unknown managed text unchanged instead of translating arbitrary UI keys", () => {
    const i18n = createI18nInstance("zh-CN");
    expect(translateManagedDashboardText("Save", "LANGFUSE", i18n.t)).toBe(
      "Save",
    );
    expect(
      translateManagedDashboardText("Future dashboard", "LANGFUSE", i18n.t),
    ).toBe("Future dashboard");
  });
});
