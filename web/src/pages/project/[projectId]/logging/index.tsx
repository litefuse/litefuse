/**
 * Next.js Pages Router route: /project/[projectId]/logging
 *
 * Entry point for the Logging (log explorer) feature.
 */
import React from "react";
import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import PageDiscover from "@/src/features/discover/views/PageDiscover";
import { env } from "@/src/env.mjs";

export default function LoggingPage() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const isLoggingEnabled = env.NEXT_PUBLIC_ENABLE_LOGGING === "true";

  React.useEffect(() => {
    if (!isLoggingEnabled && projectId) {
      void router.replace(`/project/${projectId}/traces`);
    }
  }, [isLoggingEnabled, projectId, router]);

  if (!isLoggingEnabled) {
    return null;
  }

  return (
    <Page headerProps={{ title: "Logging" }}>
      {projectId ? <PageDiscover /> : null}
    </Page>
  );
}
