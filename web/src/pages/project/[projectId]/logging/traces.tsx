/**
 * Next.js route: /project/[projectId]/logging/traces
 *
 * Entry point for the Traces (distributed tracing explorer) view.
 */
import React from "react";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";
import Page from "@/src/components/layouts/page";

const PageTrace = dynamic(
  () => import("@/src/features/discover/views/PageTrace"),
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        Loading…
      </div>
    ),
  },
);

export default function LoggingTracesPage() {
  const router = useRouter();
  const projectId = router.query.projectId as string;

  return (
    <Page headerProps={{ title: "Traces" }} scrollable>
      {projectId ? <PageTrace /> : null}
    </Page>
  );
}
