import { i18nKey } from "@/src/features/i18n/i18nKey";
export const DATASET_TABS = {
  RUNS: "runs",
  ITEMS: "items",
} as const;

export type DatasetTab = (typeof DATASET_TABS)[keyof typeof DATASET_TABS];

export const getDatasetTabs = (projectId: string, datasetId: string) => {
  return [
    {
      value: DATASET_TABS.RUNS,
      label: i18nKey("Runs"),
      href: `/project/${projectId}/datasets/${datasetId}`,
    },
    {
      value: DATASET_TABS.ITEMS,
      label: i18nKey("Items"),
      href: `/project/${projectId}/datasets/${datasetId}/items`,
    },
  ];
};
