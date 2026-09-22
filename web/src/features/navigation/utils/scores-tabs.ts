import { i18nKey } from "@/src/features/i18n/i18nKey";
export const SCORES_TABS = {
  SCORES: "scores",
  ANALYTICS: "analytics",
} as const;

export type ScoresTab = (typeof SCORES_TABS)[keyof typeof SCORES_TABS];

export const getScoresTabs = (projectId: string) => [
  {
    value: SCORES_TABS.SCORES,
    label: i18nKey("Scores"),
    href: `/project/${projectId}/scores`,
  },
  {
    value: SCORES_TABS.ANALYTICS,
    label: i18nKey("Analytics"),
    href: `/project/${projectId}/scores/analytics`,
  },
];
