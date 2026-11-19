import React from "react";
import { useRouter } from "next/router";
import SessionsTable from "@/src/components/table/use-cases/sessions";
import Page from "@/src/components/layouts/page";
import { SessionsOnboarding } from "@/src/components/onboarding/SessionsOnboarding";
import { api } from "@/src/utils/api";
import { useV4Beta } from "@/src/features/events/hooks/useV4Beta";

import { Trans, useTranslation } from "react-i18next";
export default function Sessions() {
  const { t } = useTranslation();
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const { isBetaEnabled } = useV4Beta();

  const { data: hasAnySession, isLoading } = api.sessions.hasAny.useQuery(
    { projectId },
    {
      enabled: !!projectId && !isBetaEnabled,
      trpc: {
        context: {
          skipBatch: true,
        },
      },
      refetchInterval: 10_000,
    },
  );

  const { data: hasAnySessionFromEvents, isLoading: isLoadingFromEvents } =
    api.sessions.hasAnyFromEvents.useQuery(
      { projectId },
      {
        enabled: !!projectId && isBetaEnabled,
        trpc: {
          context: {
            skipBatch: true,
          },
        },
        refetchInterval: 10_000,
      },
    );

  const hasSessions = isBetaEnabled ? hasAnySessionFromEvents : hasAnySession;
  const isLoadingSessions = isBetaEnabled ? isLoadingFromEvents : isLoading;
  const showOnboarding = !isLoadingSessions && !hasSessions;

  return (
    <Page
      headerProps={{
        title: t("Sessions"),
        help: {
          description: (
            <>
              <Trans
                i18nKey="A session is a collection of related traces, such as a conversation or thread. To begin, add a sessionId to the trace. See <0>docs</0> to learn more."
                components={[
                  <a
                    key="0"
                    href="https://litefuse.ai/docs/observability/features/sessions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="decoration-primary/30 hover:decoration-primary underline"
                    onClick={(e) => e.stopPropagation()}
                  />,
                ]}
              />
            </>
          ),
          href: "https://litefuse.ai/docs/observability/features/sessions",
        },
      }}
      scrollable={showOnboarding}
    >
      {/* Show onboarding screen if user has no sessions */}
      {showOnboarding ? (
        <SessionsOnboarding />
      ) : (
        <SessionsTable projectId={projectId} isBetaEnabled={isBetaEnabled} />
      )}
    </Page>
  );
}
