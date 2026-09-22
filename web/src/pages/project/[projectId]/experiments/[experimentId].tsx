import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";

import { useTranslation } from "react-i18next";
export default function ExperimentDetail() {
  const { t } = useTranslation();
  const router = useRouter();
  const experimentId = router.query.experimentId as string;

  return (
    <Page
      headerProps={{
        title: t("Experiment Detail"),
        help: {
          description: t(
            "View and analyze a specific experiment run. See docs to learn more.",
          ),
          href: "https://litefuse.ai/docs/datasets/experiments",
        },
      }}
    >
      <div className="p-4">
        <p>{t("Experiment Detail View - Coming Soon")}</p>
        <p>{t("Experiment ID: {{id}}", { id: experimentId })}</p>
      </div>
    </Page>
  );
}
