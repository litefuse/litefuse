import { useRouter } from "next/router";
import { usePeekData } from "@/src/components/table/peek/hooks/usePeekData";
import { Trace } from "@/src/components/trace2/Trace";
import { Skeleton } from "@/src/components/ui/skeleton";
import { StringParam, useQueryParam, withDefault } from "use-query-params";
import { useObservationContent } from "@/src/components/trace2/api/useObservationContent";
import { type ObservationPreviewReference } from "@/src/features/observations/lib/observationBatchPreview";
export const PeekViewObservationDetail = ({
  projectId,
  observationReferences = [],
}: {
  projectId: string;
  observationReferences?: ObservationPreviewReference[];
}) => {
  const router = useRouter();
  const peekId = router.query.peek as string | undefined;
  const timestamp = router.query.timestamp
    ? new Date(router.query.timestamp as string)
    : undefined;
  const traceId = router.query.traceId as string | undefined;

  const trace = usePeekData({
    projectId,
    traceId,
    timestamp,
  });

  // The URL timestamp belongs to the Trace, not the Observation. Only start
  // early with an unambiguous reference from the current list; old links and
  // selections elsewhere in the trace tree retain the normal detail loader.
  const references = observationReferences.filter(
    (reference) => reference.id === peekId && reference.traceId === traceId,
  );
  const reference = references.length === 1 ? references[0] : undefined;
  const canLoadEarly = Boolean(
    projectId &&
      peekId &&
      traceId &&
      reference &&
      Number.isFinite(reference.startTime.getTime()) &&
      (!router.query.observation || router.query.observation === peekId),
  );
  useObservationContent({
    projectId,
    observationId: peekId ?? "",
    traceId: traceId ?? "",
    startTime: canLoadEarly ? reference?.startTime : undefined,
    enabled: canLoadEarly,
  });

  const [selectedTab, setSelectedTab] = useQueryParam(
    "display",
    withDefault(StringParam, "details"),
  );

  if (!peekId || !trace.data) {
    return <Skeleton className="h-full w-full rounded-none" />;
  }

  return (
    <Trace
      key={`${trace.data.id}-${peekId}`}
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
