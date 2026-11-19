import { type ParsedUrlQuery } from "querystring";

import { i18nKey } from "@/src/features/i18n/i18nKey";
export const DATASET_RUN_COMPARE_TABS = {
  COMPARE: "compare",
  CHARTS: "charts",
} as const;

export type DatasetRunCompareTab =
  (typeof DATASET_RUN_COMPARE_TABS)[keyof typeof DATASET_RUN_COMPARE_TABS];

export const getDatasetRunCompareTabs = (
  projectId: string,
  datasetId: string,
) => [
  {
    value: DATASET_RUN_COMPARE_TABS.COMPARE,
    label: i18nKey("Outputs"),
    href: `/project/${projectId}/datasets/${datasetId}/compare`,
    querySelector: (query: ParsedUrlQuery) => ({ runs: query.runs }),
  },
  {
    value: DATASET_RUN_COMPARE_TABS.CHARTS,
    label: i18nKey("Charts"),
    href: `/project/${projectId}/datasets/${datasetId}/compare/charts`,
    querySelector: (query: ParsedUrlQuery) => ({ runs: query.runs }),
  },
];
