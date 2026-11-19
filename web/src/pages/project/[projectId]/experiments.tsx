import Page from "@/src/components/layouts/page";

import { useTranslation } from "react-i18next";
export default function Experiments() {
  const { t } = useTranslation();
  return (
    <Page
      headerProps={{
        title: t("Experiments"),
        help: {
          description: t(
            "Experiments allow you to compare and analyze different runs of your LLM application. See docs to learn more.",
          ),
          href: "https://litefuse.ai/docs/datasets/experiments",
        },
      }}
    >
      <div className="p-4">
        <p>{t("Experiments List View - Coming Soon")}</p>
      </div>
    </Page>
  );
}
