import { usePeekData } from "@/src/components/table/peek/hooks/usePeekData";
import { useRouter } from "next/router";
import { Trace } from "@/src/components/trace2/Trace";
import { Skeleton } from "@/src/components/ui/skeleton";
import { StringParam, useQueryParam, withDefault } from "use-query-params";

export const PeekViewTraceDetail = ({ projectId }: { projectId: string }) => {
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
        <p className="font-medium">未找到 Trace</p>
        <p className="text-xs opacity-70">
          Trace ID：{peekId}
          <br />该 Trace 可能尚未同步到 Litefuse，或所属项目与当前项目不一致。
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
