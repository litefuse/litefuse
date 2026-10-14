import { api } from "@/src/utils/api";
import { useV4Beta } from "@/src/features/events/hooks/useV4Beta";

/** Shared full-content query keys for early peek loading and the detail view. */
export function useObservationContent({
  observationId,
  traceId,
  projectId,
  startTime,
  enabled = true,
}: {
  observationId: string;
  traceId: string;
  projectId: string;
  startTime?: Date;
  enabled?: boolean;
}) {
  const { isBetaEnabled } = useV4Beta();

  // Step 1a: Fetch raw observation data from observations table (beta OFF)
  const observationQuery = api.observations.byId.useQuery(
    {
      observationId,
      traceId,
      projectId,
      startTime,
    },
    {
      enabled: enabled && !isBetaEnabled,
      staleTime: 5 * 60 * 1000, // 5 minutes
    },
  );

  // Step 1b: Fetch raw observation data from events table (beta ON)
  const eventsQuery = api.events.batchIO.useQuery(
    {
      projectId,
      observations: [{ id: observationId, traceId }],
      minStartTime: startTime ?? new Date(0),
      // Disabled queries still enter the React Query cache. Keep their keys
      // stable while a closed peek or a link without a reference rerenders.
      maxStartTime:
        startTime ?? (enabled && isBetaEnabled ? new Date() : new Date(0)),
      truncated: false,
    },
    {
      enabled: enabled && isBetaEnabled,
      staleTime: 5 * 60 * 1000, // 5 minutes
      select: (data) => data[0], // Extract single result from batch
    },
  );

  return { isBetaEnabled, observationQuery, eventsQuery };
}
