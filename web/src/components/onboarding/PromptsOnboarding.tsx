import React from "react";
import {
  SplashScreen,
  type ValueProposition,
} from "@/src/components/ui/splash-screen";
import { FileText, GitBranch, Zap, BarChart4 } from "lucide-react";

import { useTranslation } from "react-i18next";
export function PromptsOnboarding({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const valuePropositions: ValueProposition[] = [
    {
      title: t("Decoupled from code"),
      description: t(
        "Deploy new prompts without application redeployment, making updates faster and easier",
      ),
      icon: <FileText className="h-4 w-4" />,
    },
    {
      title: t("Edit in UI or programmatically"),
      description: t(
        "Non-technical users can easily edit prompts in the UI. Developers can optionally update prompts programmatically via the API and SDKs",
      ),
      icon: <GitBranch className="h-4 w-4" />,
    },
    {
      title: t("Performance optimized"),
      description: t(
        "Client-side caching prevents latency or availability issues for your applications",
      ),
      icon: <Zap className="h-4 w-4" />,
    },
    {
      title: t("Compare metrics"),
      description: t(
        "Track latency, cost, and evaluation metrics across different prompt versions",
      ),
      icon: <BarChart4 className="h-4 w-4" />,
    },
  ];

  return (
    <SplashScreen
      title={t("Get Started with Prompt Management")}
      description={t(
        "Litefuse Prompt Management helps you centrally manage, version control, and collaboratively iterate on your prompts. Start using prompt management to improve your LLM application's performance and maintainability.",
      )}
      valuePropositions={valuePropositions}
      primaryAction={{
        label: t("Create Prompt"),
        href: `/project/${projectId}/prompts/new`,
      }}
      secondaryAction={{
        label: t("Learn More"),
        href: "https://litefuse.ai/docs/prompt-management/get-started",
      }}
    />
  );
}
