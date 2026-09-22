import React from "react";
import { SplashScreen } from "@/src/components/ui/splash-screen";
import { ActionButton } from "@/src/components/ActionButton";

import { Trans, useTranslation } from "react-i18next";
export function SessionsOnboarding() {
  const { t } = useTranslation();
  return (
    <SplashScreen
      title={t("You aren't using sessions yet")}
      description={t(
        "Sessions let you group traces that belong to the same workflow, or conversation.",
      )}
      videoSrc="https://static.litefuse.ai/prod-assets/onboarding/sessions-overview-v1.mp4"
    >
      <div className="mt-8">
        <h3 className="mb-4 text-2xl font-semibold">
          {t("Start using sessions")}
        </h3>
        <p className="text-muted-foreground mb-4 text-sm">
          <Trans>
            To start using sessions, you need to add a <code>sessionId</code> to
            your traces.
          </Trans>
        </p>
        <ActionButton
          href="https://litefuse.ai/docs/observability/features/sessions"
          variant="default"
        >
          {t("Read the docs")}
        </ActionButton>
      </div>
    </SplashScreen>
  );
}
