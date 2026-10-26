import { usePeekData } from "@/src/components/table/peek/hooks/usePeekData";
import { useRouter } from "next/router";
import { Trace } from "@/src/components/trace2/Trace";
import { Skeleton } from "@/src/components/ui/skeleton";
import { StringParam, useQueryParam, withDefault } from "use-query-params";

import { useTranslation } from "react-i18next";
export const PeekViewTraceDetail = ({ projectId }: { projectId: string }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const peekId = router.query.peek as string | undefined;
  const peekProjectId =
    typeof router.query.peekProjectId === "string"
      ? router.query.peekProjectId
      : projectId;
  const timestamp = router.query.timestamp
    ? new Date(router.query.timestamp as string)
    : undefined;
  const trace = usePeekData({
    projectId: peekProjectId,
    traceId: peekId,
    timestamp,
  });

  const [selectedTab, setSelectedTab] = useQueryParam(
    "display",
    withDefault(StringParam, "details"),
  );

  if (!peekId) return null;
  if (trace.isLoading || trace.isFetching) {
    return <Skeleton className="h-full w-full rounded-none" />;
  }
  if (!trace.data) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm">
        <p className="font-medium">{t("Trace not found")}</p>
        <p className="text-xs opacity-70">
          {t("Trace ID: {{id}}", { id: peekId })}
          <br />
          {t(
            "This trace may not have reached Litefuse yet, or it belongs to a different project.",
          )}
        </p>
      </div>
    );
  }
  return (
    <Trace
      key={trace.data.id}
      trace={trace.data}
      scores={trace.data.scores}
      corrections={trace.data.corrections}
      projectId={trace.data.projectId}
      observations={trace.data.observations}
      selectedTab={selectedTab}
      setSelectedTab={setSelectedTab}
      context="peek"
    />
  );
};

// ── Added for the evaluators v2 migration (adapter, not an upstream copy) ────
// Upstream's TablePeekViewTraceDetail is a thin wrapper: their \`TablePeekView\` shell
// around \`TraceDetailBody\`. We do not have that shell — our PeekViewTraceDetail
// renders the peek itself — so this accepts the props the evaluator pages spread and
// delegates to ours.
//
// Props that are ACCEPTED AND IGNORED (they configure upstream's shell, not the
// peek content): the \`PeekNavigation\` fields (openPeek/closePeek/isPeekOpen/...),
// \`itemType\`, \`detailNavigationKey\`, \`layout\` and the expand config. Consequence:
// the peek renders and its data loads, but shell-level behaviours that depend on
// them (keyboard row navigation between peeks, expanding to the full trace page from
// the peek header) do not. Recorded as an evaluator-page wiring item.
//
// Replacement suggestion: bring our own peek shell up to the newer contract, or
// port upstream's TablePeekView, then drop the ignore-list above.
export const TablePeekViewTraceDetail = ({
  projectId,
}: {
  projectId: string;
} & Record<string, unknown>) => <PeekViewTraceDetail projectId={projectId} />;
