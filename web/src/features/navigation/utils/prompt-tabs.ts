import { i18nKey } from "@/src/features/i18n/i18nKey";
export const PROMPT_TABS = {
  VERSIONS: "versions",
  METRICS: "metrics",
} as const;

export type PromptTab = (typeof PROMPT_TABS)[keyof typeof PROMPT_TABS];

export const getPromptTabs = (projectId: string, promptName: string) => [
  {
    value: PROMPT_TABS.VERSIONS,
    label: i18nKey("Versions"),
    href: `/project/${projectId}/prompts/${encodeURIComponent(promptName)}`,
  },
  {
    value: PROMPT_TABS.METRICS,
    label: i18nKey("Metrics"),
    href: `/project/${projectId}/prompts/${encodeURIComponent(promptName)}/metrics`,
  },
];
