import React from "react";
import {
  SplashScreen,
  type ValueProposition,
} from "@/src/components/ui/splash-screen";
import { ClipboardCheck, Users, BarChart4, GitMerge } from "lucide-react";
import { CreateOrEditAnnotationQueueButton } from "@/src/features/annotation-queues/components/CreateOrEditAnnotationQueueButton";

import { useTranslation } from "react-i18next";
export function AnnotationQueuesOnboarding({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const valuePropositions: ValueProposition[] = [
    {
      title: t("Manage scoring workflows"),
      description: t(
        "Create and manage annotation queues to streamline your scoring workflows",
      ),
      icon: <ClipboardCheck className="h-4 w-4" />,
    },
    {
      title: t("Collaborate with annotators"),
      description: t(
        "Invite team members to annotate and evaluate your LLM outputs",
      ),
      icon: <Users className="h-4 w-4" />,
    },
    {
      title: t("Track annotation metrics"),
      description: t(
        "Monitor annotation progress and quality metrics across your team",
      ),
      icon: <BarChart4 className="h-4 w-4" />,
    },
    {
      title: t("Baseline evaluation efforts"),
      description: t(
        "Use annotation data as a baseline to evaluate your other evaluation metrics",
      ),
      icon: <GitMerge className="h-4 w-4" />,
    },
  ];

  return (
    <SplashScreen
      title={t("Get Started with Annotation Queues")}
      description={t(
        "Annotation queues help you manage manual annotation/labeling for your LLM projects. Create queues, define annotation metrics, and track progress.",
      )}
      valuePropositions={valuePropositions}
      primaryAction={{
        label: t("Create Annotation Queue"),
        component: (
          <CreateOrEditAnnotationQueueButton
            variant="default"
            projectId={projectId}
            size="lg"
          />
        ),
      }}
      secondaryAction={{
        label: t("Learn More"),
        href: "https://litefuse.ai/docs/scores/annotation",
      }}
      videoSrc="https://static.litefuse.ai/prod-assets/onboarding/annotation-queue-overview-v1.mp4"
    />
  );
}
