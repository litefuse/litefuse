import type { DatasetItemDomain } from "@langfuse/shared";
import {
  stringifyDatasetItemData,
  type DatasetSchema,
} from "../utils/datasetItemUtils";
import { DatasetItemFields } from "@/src/features/datasets/components/DatasetItemFields";

import { useTranslation } from "react-i18next";
type DatasetItemViewModeContentProps = {
  item: DatasetItemDomain | null;
  isLoading: boolean;
  dataset: DatasetSchema | null;
};

/**
 * Renders the latest version of a dataset item in view mode.
 * Handles loading and not-found states.
 */
export const DatasetItemViewModeContent = ({
  item,
  isLoading,
  dataset,
}: DatasetItemViewModeContentProps) => {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <div className="text-muted-foreground text-sm">{t("Loading...")}</div>
    );
  }

  if (item === null) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <div className="text-muted-foreground">
          <p className="text-lg font-medium">{t("Dataset item not found")}</p>
          <p className="mt-2 text-sm">
            {t("This dataset item does not exist or has been deleted.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <DatasetItemFields
      inputValue={stringifyDatasetItemData(item.input)}
      expectedOutputValue={stringifyDatasetItemData(item.expectedOutput)}
      metadataValue={stringifyDatasetItemData(item.metadata)}
      dataset={dataset}
      editable={false}
    />
  );
};
