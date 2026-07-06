import { isGraphViewAvailable } from "./graph-availability";
import { type AgentGraphDataResponse } from "@/src/features/trace-graph-view/types";

const createGraphData = (
  overrides: Partial<AgentGraphDataResponse> = {},
): AgentGraphDataResponse => ({
  id: "obs-1",
  node: "generation",
  step: 0,
  parentObservationId: null,
  name: "generation",
  startTime: "2024-01-01T00:00:00.000Z",
  endTime: "2024-01-01T00:00:01.000Z",
  observationType: "GENERATION",
  ...overrides,
});

describe("isGraphViewAvailable", () => {
  it("allows timing-based graphs for generation observations", () => {
    expect(isGraphViewAvailable([createGraphData()])).toBe(true);
  });

  it("hides graph view for event-only traces", () => {
    expect(
      isGraphViewAvailable([
        createGraphData({
          observationType: "EVENT",
        }),
      ]),
    ).toBe(false);
  });

  it("allows LangGraph data even when the observation is an event", () => {
    expect(
      isGraphViewAvailable([
        createGraphData({
          observationType: "EVENT",
          node: "agent",
          step: 1,
        }),
      ]),
    ).toBe(true);
  });
});
