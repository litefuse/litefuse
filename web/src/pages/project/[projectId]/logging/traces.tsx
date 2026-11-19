/**
 * Next.js route: /project/[projectId]/logging/traces
 *
 * Entry point for the Traces (distributed tracing explorer) view.
 */
import React from "react";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";
import Page from "@/src/components/layouts/page";

import { useTranslation } from "react-i18next";
const PageTrace = dynamic(
  () => import("@/src/features/discover/views/PageTrace"),
  {
    ssr: false,
    loading: function DiscoverLoading() {
      const { t } = useTranslation();
      return (
        <div className="text-muted-foreground flex h-full items-center justify-center">
          {t("Loading…")}
        </div>
      );
    },
  },
);

export default function LoggingTracesPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const projectId = router.query.projectId as string;

  return (
    <Page headerProps={{ title: t("Traces") }} scrollable>
      {projectId ? <PageTrace /> : null}
    </Page>
  );
}
