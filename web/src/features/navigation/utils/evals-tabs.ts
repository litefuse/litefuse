import { i18nKey } from "@/src/features/i18n/i18nKey";
export const EVALS_TABS = {
  CONFIGS: "configs",
  TEMPLATES: "templates",
} as const;

export type EvalsTab = (typeof EVALS_TABS)[keyof typeof EVALS_TABS];

export const getEvalsTabs = (projectId: string) => [
  {
    value: EVALS_TABS.CONFIGS,
    label: i18nKey("Running Evaluators"),
    href: `/project/${projectId}/evals`,
  },
  {
    value: EVALS_TABS.TEMPLATES,
    label: i18nKey("Evaluator Library"),
    href: `/project/${projectId}/evals/templates`,
  },
];
