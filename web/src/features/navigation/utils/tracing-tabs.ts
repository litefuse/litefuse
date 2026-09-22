import { i18nKey } from "@/src/features/i18n/i18nKey";
export const TRACING_TABS = {
  TRACES: "traces",
  OBSERVATIONS: "observations",
} as const;

export type TracingTab = (typeof TRACING_TABS)[keyof typeof TRACING_TABS];

export const getTracingTabs = (projectId: string) => [
  {
    value: TRACING_TABS.TRACES,
    label: i18nKey("Traces"),
    href: `/project/${projectId}/traces`,
  },
  {
    value: TRACING_TABS.OBSERVATIONS,
    label: i18nKey("Observations"),
    href: `/project/${projectId}/observations`,
  },
];
