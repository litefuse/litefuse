import { type ObservationEvalCandidate } from "@langfuse/shared/src/server";
import { logger, traceException } from "@langfuse/shared/src/server";
import { fetchObservationEvalConfigs } from "./fetchObservationEvalConfigs";
import { scheduleObservationEvals } from "./scheduleObservationEvals";
import { createObservationEvalSchedulerDeps } from "./createSchedulerDeps";
import { convertEventRecordToObservationForEval } from "./convertEventRecordToObservationForEval";

export async function scheduleDirectObservationEvals(
  candidates: ObservationEvalCandidate[],
): Promise<void> {
  if (candidates.length === 0) {
    return;
  }

  // OTel ingestion currently emits one project per request, but grouping
  // defensively prevents cross-project mis-scheduling if that invariant changes.
  const candidatesByProject = candidates.reduce<
    Map<string, ObservationEvalCandidate[]>
  >((acc, candidate) => {
    const projectId = candidate.eventRecord.project_id;
    const projectCandidates = acc.get(projectId);
    if (projectCandidates) {
      projectCandidates.push(candidate);
    } else {
      acc.set(projectId, [candidate]);
    }
    return acc;
  }, new Map());

  const projectGroups = Array.from(candidatesByProject.entries());
  const groupResults = await Promise.allSettled(
    projectGroups.map(async ([projectId, projectCandidates]) => {
      const configs = await fetchObservationEvalConfigs(projectId);
      if (configs.length === 0) {
        return;
      }

      const schedulerDeps = createObservationEvalSchedulerDeps();
      const scheduleResults = await Promise.allSettled(
        projectCandidates.map(({ eventRecord, startTimeDate }) =>
          scheduleObservationEvals({
            observation: convertEventRecordToObservationForEval(eventRecord),
            startTimeDate,
            configs,
            schedulerDeps,
          }),
        ),
      );

      scheduleResults.forEach((result, index) => {
        if (result.status === "rejected") {
          const failedCandidate = projectCandidates[index];
          traceException(result.reason);
          logger.error("Failed to schedule direct observation eval", {
            error: result.reason,
            projectId,
            spanId: failedCandidate.eventRecord.span_id,
            startTimeDate: failedCandidate.startTimeDate,
          });
        }
      });
    }),
  );

  groupResults.forEach((result, index) => {
    if (result.status === "rejected") {
      const [projectId, projectCandidates] = projectGroups[index];
      traceException(result.reason);
      logger.error("Failed to prepare direct observation eval scheduling", {
        error: result.reason,
        projectId,
        spanIds: projectCandidates.map(
          (candidate) => candidate.eventRecord.span_id,
        ),
      });
    }
  });
}
