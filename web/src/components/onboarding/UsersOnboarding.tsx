import React from "react";
import { SplashScreen } from "@/src/components/ui/splash-screen";
import { ActionButton } from "@/src/components/ActionButton";

import { Trans, useTranslation } from "react-i18next";
export function UsersOnboarding() {
  const { t } = useTranslation();
  return (
    <SplashScreen
      title={t("You aren't tracking users yet")}
      description={t(
        "Once you add a user ID to your traces, you can correlate costs, evaluations and other LLM Application metrics to better understand how they interact with your LLM applications.",
      )}
      videoSrc="https://static.litefuse.ai/prod-assets/onboarding/users-overview-v1.mp4"
    >
      <div className="mt-8">
        <h3 className="mb-4 text-2xl font-semibold">
          {t("Start tracking users")}
        </h3>
        <p className="text-muted-foreground mb-4 text-sm">
          <Trans>
            To start tracking users, you need to add a <code>userId</code> to
            your traces.
          </Trans>
        </p>
        <ActionButton
          href="https://litefuse.ai/docs/observability/features/users"
          variant="default"
        >
          {t("Read the docs")}
        </ActionButton>
      </div>
    </SplashScreen>
  );
}
