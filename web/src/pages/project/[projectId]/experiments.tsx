import Page from "@/src/components/layouts/page";
import useLocalStorage from "@/src/components/useLocalStorage";
import { DatasetRunsTable } from "@/src/features/datasets/components/DatasetRunsTable";
import { RESOURCE_METRICS } from "@/src/features/dashboard/lib/score-analytics-utils";
import { DatasetAnalytics } from "@/src/features/datasets/components/DatasetAnalytics";
import { useRouter } from "next/router";
import { useState } from "react";

export default function Experiments() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const [selectedMetrics, setSelectedMetrics] = useLocalStorage<string[]>(
    `${projectId}-experiments-chart-metrics`,
    RESOURCE_METRICS.map((metric) => metric.key),
  );
  const [scoreOptions, setScoreOptions] = useState<
    {
      key: string;
      value: string;
    }[]
  >([]);

  return (
    <Page
      headerProps={{
        title: "Experiments",
        help: {
          description:
            "Experiments allow you to compare and analyze different runs of your LLM application. See docs to learn more.",
          href: "https://litefuse.ai/docs/datasets/experiments",
        },
        actionButtonsRight: (
          <DatasetAnalytics
            key="experiments-analytics"
            projectId={projectId}
            scoreOptions={scoreOptions}
            selectedMetrics={selectedMetrics}
            setSelectedMetrics={setSelectedMetrics}
          />
        ),
      }}
    >
      <DatasetRunsTable
        projectId={projectId}
        selectedMetrics={selectedMetrics}
        setScoreOptions={setScoreOptions}
      />
    </Page>
  );
}
