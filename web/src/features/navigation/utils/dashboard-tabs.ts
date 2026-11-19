import { i18nKey } from "@/src/features/i18n/i18nKey";
export const DASHBOARD_TABS = {
  DASHBOARDS: "dashboards",
  WIDGETS: "widgets",
} as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[keyof typeof DASHBOARD_TABS];

export const getDashboardTabs = (projectId: string) => [
  {
    value: DASHBOARD_TABS.DASHBOARDS,
    label: i18nKey("Dashboards"),
    href: `/project/${projectId}/dashboards`,
  },
  {
    value: DASHBOARD_TABS.WIDGETS,
    label: i18nKey("Widgets"),
    href: `/project/${projectId}/widgets`,
  },
];
