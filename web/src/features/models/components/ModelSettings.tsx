import Header from "@/src/components/layouts/header";
import ModelTable from "@/src/components/table/use-cases/models";

import { useTranslation } from "react-i18next";
export function ModelsSettings(props: { projectId: string }) {
  const { t } = useTranslation();
  return (
    <>
      <Header title={t("Model Definitions")} />
      <p className="mb-2 text-sm">
        {t(
          "A configuration that stores pricing information for an LLM model. Model definitions specify the cost per input and output token, enabling Litefuse to automatically calculate the price of generations based on token usage.",
        )}
      </p>
      <ModelTable projectId={props.projectId} />
    </>
  );
}
