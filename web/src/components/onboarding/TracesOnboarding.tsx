import React from "react";
import { SplashScreen } from "@/src/components/ui/splash-screen";
import { TracingSetup } from "@/src/pages/project/[projectId]/traces/setup";

import { useTranslation } from "react-i18next";
interface TracesOnboardingProps {
  projectId: string;
}

export function TracesOnboarding({ projectId }: TracesOnboardingProps) {
  const { t } = useTranslation();
  return (
    <SplashScreen
      title={t("You don't have any traces yet")}
      description={t(
        "Traces show you how your LLM calls behave in your application: what they cost, how they perform, and where things go wrong. It's the first step towards improving the behavior of your app.",
      )}
      videoSrc="https://static.litefuse.ai/prod-assets/onboarding/tracing-overview-v1.mp4"
    >
      <div className="mt-8">
        <h3 className="mb-8 text-2xl font-semibold">{t("Get started")}</h3>
        <TracingSetup projectId={projectId} hasTracingConfigured={false} />
      </div>
    </SplashScreen>
  );
}
