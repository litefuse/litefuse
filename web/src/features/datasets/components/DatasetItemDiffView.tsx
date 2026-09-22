import type { DatasetItemDomain } from "@langfuse/shared";
import DiffViewer from "@/src/components/DiffViewer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/src/components/ui/accordion";
import { stringifyDatasetItemData } from "../utils/datasetItemUtils";

import { useTranslation } from "react-i18next";
type DatasetItemDiffViewProps = {
  selectedVersion: DatasetItemDomain;
  latestVersion: DatasetItemDomain;
};

export const DatasetItemDiffView = ({
  selectedVersion,
  latestVersion,
}: DatasetItemDiffViewProps) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <Accordion
        type="multiple"
        defaultValue={["input", "output"]}
        className="w-full"
      >
        <AccordionItem value="input">
          <AccordionTrigger>{t("Input")}</AccordionTrigger>
          <AccordionContent>
            <DiffViewer
              oldString={stringifyDatasetItemData(selectedVersion.input)}
              newString={stringifyDatasetItemData(latestVersion.input)}
              oldLabel={t("Selected Version")}
              newLabel={t("Latest Version")}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="output">
          <AccordionTrigger>{t("Expected Output")}</AccordionTrigger>
          <AccordionContent>
            <DiffViewer
              oldString={stringifyDatasetItemData(
                selectedVersion.expectedOutput,
              )}
              newString={stringifyDatasetItemData(latestVersion.expectedOutput)}
              oldLabel={t("Selected Version")}
              newLabel={t("Latest Version")}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="metadata">
          <AccordionTrigger>{t("Metadata")}</AccordionTrigger>
          <AccordionContent>
            <DiffViewer
              oldString={stringifyDatasetItemData(selectedVersion.metadata)}
              newString={stringifyDatasetItemData(latestVersion.metadata)}
              oldLabel={t("Selected Version")}
              newLabel={t("Latest Version")}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
};
