import React from "react";
import {
  SplashScreen,
  type ValueProposition,
} from "@/src/components/ui/splash-screen";
import { Database, Beaker, Zap, Code } from "lucide-react";
import { DatasetActionButton } from "@/src/features/datasets/components/DatasetActionButton";

import { useTranslation } from "react-i18next";
export function DatasetsOnboarding({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const valuePropositions: ValueProposition[] = [
    {
      title: t("Continuous improvement"),
      description: t(
        "Create datasets from production edge cases to improve your application",
      ),
      icon: <Zap className="h-4 w-4" />,
    },
    {
      title: t("Pre-deployment testing"),
      description: t("Benchmark new releases before deploying to production"),
      icon: <Beaker className="h-4 w-4" />,
    },
    {
      title: t("Structured testing"),
      description: t(
        "Run experiments on collections of inputs and expected outputs",
      ),
      icon: <Database className="h-4 w-4" />,
    },
    {
      title: t("Custom workflows"),
      description: t(
        "Build custom workflows around your datasets via the API and SDKs, e.g. for fine-tuning, few-shotting",
      ),
      icon: <Code className="h-4 w-4" />,
    },
  ];

  return (
    <SplashScreen
      title={t("Get Started with Datasets & Experiments")}
      description={t(
        "Datasets in Litefuse are collections of inputs (and expected outputs) for your LLM application. You can run Experiments against these datasets to test new releases before deployment to production.",
      )}
      valuePropositions={valuePropositions}
      primaryAction={{
        label: t("Create Dataset"),
        component: (
          <DatasetActionButton
            variant="default"
            mode="create"
            projectId={projectId}
            size="lg"
          />
        ),
      }}
      secondaryAction={{
        label: t("Learn More"),
        href: "https://litefuse.ai/docs/datasets",
      }}
      videoSrc="https://static.litefuse.ai/prod-assets/onboarding/datasets-overview-v1.mp4"
    />
  );
}
