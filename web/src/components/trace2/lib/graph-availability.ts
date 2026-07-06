import { type AgentGraphDataResponse } from "@/src/features/trace-graph-view/types";

const MAX_NODES_FOR_GRAPH_UI = 5000;

export function isGraphViewAvailable(
  agentGraphData: AgentGraphDataResponse[],
): boolean {
  if (agentGraphData.length === 0) {
    return false;
  }

  if (agentGraphData.length >= MAX_NODES_FOR_GRAPH_UI) {
    return false;
  }

  const hasLangGraphData = agentGraphData.some(
    (obs) => obs.step != null && obs.step !== 0,
  );

  if (hasLangGraphData) {
    return true;
  }

  const hasGraphableObservations = agentGraphData.some(
    (obs) => obs.observationType !== "EVENT",
  );

  return hasGraphableObservations;
}
