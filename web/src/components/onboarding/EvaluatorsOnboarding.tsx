import React from "react";
import {
  SplashScreen,
  type ValueProposition,
} from "@/src/components/ui/splash-screen";
import { Bot, Gauge, Zap, BarChart4 } from "lucide-react";

import { useTranslation } from "react-i18next";
interface EvaluatorsOnboardingProps {
  projectId: string;
}

export function EvaluatorsOnboarding({ projectId }: EvaluatorsOnboardingProps) {
  const { t } = useTranslation();
  const valuePropositions: ValueProposition[] = [
    {
      title: t("Automate evaluations"),
      description: t(
        "Use LLM-as-a-judge to automatically evaluate your traces without manual review",
      ),
      icon: <Bot className="h-4 w-4" />,
    },
    {
      title: t("Measure quality"),
      description: t(
        "Create custom evaluation criteria to measure the quality of your LLM outputs",
      ),
      icon: <Gauge className="h-4 w-4" />,
    },
    {
      title: t("Scale efficiently"),
      description: t(
        "Evaluate thousands of traces automatically with customizable sampling rates",
      ),
      icon: <Zap className="h-4 w-4" />,
    },
    {
      title: t("Track performance"),
      description: t(
        "Monitor evaluation metrics over time to identify trends and improvements",
      ),
      icon: <BarChart4 className="h-4 w-4" />,
    },
  ];

  return (
    <SplashScreen
      title={t("Get Started with LLM-as-a-Judge Evaluations")}
      description={t(
        "Create evaluation templates and evaluators to automatically score your traces with LLM-as-a-judge. Set up custom evaluation criteria and let AI help you measure the quality of your outputs.",
      )}
      valuePropositions={valuePropositions}
      primaryAction={{
        label: t("Create Evaluator"),
        href: `/project/${projectId}/evals/new`,
      }}
      secondaryAction={{
        label: t("Learn More"),
        href: "https://litefuse.ai/docs/evaluation/evaluation-methods/llm-as-a-judge",
      }}
      videoSrc="https://static.litefuse.ai/prod-assets/onboarding/scores-llm-as-a-judge-overview-v1.mp4"
    />
  );
}
