import { i18nKey } from "@/src/features/i18n/i18nKey";
export const DATASET_ITEM_TABS = {
  ITEM: "item",
  RUNS: "runs",
} as const;

export type DatasetItemTab =
  (typeof DATASET_ITEM_TABS)[keyof typeof DATASET_ITEM_TABS];

export const getDatasetItemTabs = ({
  projectId,
  datasetId,
  itemId,
}: {
  projectId: string;
  datasetId: string;
  itemId: string;
}) => [
  {
    value: DATASET_ITEM_TABS.ITEM,
    label: i18nKey("Item"),
    href: `/project/${projectId}/datasets/${datasetId}/items/${itemId}`,
  },
  {
    value: DATASET_ITEM_TABS.RUNS,
    label: i18nKey("Runs"),
    href: `/project/${projectId}/datasets/${datasetId}/items/${itemId}/runs`,
  },
];
