import { v4 } from "uuid";
import {
  createObservationsCh,
  createTracesCh,
} from "@langfuse/shared/src/server";
import { createObservation, createTrace } from "@langfuse/shared/src/server";
import {
  getTracesTable,
  getTracesTableMetrics,
  type TracesTableUiReturnType,
  type ObservationRecordInsertType,
  type TraceRecordInsertType,
} from "@langfuse/shared/src/server";
import { type FilterState } from "@langfuse/shared";

describe("Traces table API test", () => {
  it("should get a correct trace without observation", async () => {
    const project_id = v4().replace(/-/g, "");
    const trace_id = v4();

    const trace = createTrace({ id: trace_id, project_id });
    await createTracesCh([trace]);

    const tableRows = await getTracesTable({
      projectId: project_id,
      filter: [],
      searchQuery: undefined,
      orderBy: undefined,
      limit: 1,
      page: 0,
    });

    expect(tableRows).toHaveLength(1);
    expect(tableRows[0].id).toEqual(trace_id);
    expect(tableRows[0].projectId).toEqual(project_id);
    expect(tableRows[0].tags.sort()).toEqual(trace.tags.sort());
    expect(tableRows[0].name).toEqual(trace.name);
    expect(tableRows[0].bookmarked).toEqual(trace.bookmarked);
    expect(tableRows[0].release).toEqual(trace.release);
    expect(tableRows[0].version).toEqual(trace.version);
    expect(tableRows[0].userId).toEqual(trace.user_id);
    expect(tableRows[0].sessionId).toEqual(trace.session_id);
    expect(tableRows[0].public).toEqual(trace.public);
  });

  it("#5274: should get a traces in expected default order", async () => {
    const project_id = v4().replace(/-/g, "");
    const trace_id = v4();

    // Trace1 happened after Trace2, but Trace2 got updated.
    const trace1 = createTrace({
      id: `${trace_id}-1`,
      project_id,
      timestamp: new Date().getTime(),
      event_ts: new Date().getTime(),
    });
    const trace2 = createTrace({
      id: `${trace_id}-2`,
      project_id,
      timestamp: new Date().getTime() - 5000,
      event_ts: new Date().getTime() + 5000,
    });
    await createTracesCh([trace1, trace2]);

    const tableRows = await getTracesTable({
      projectId: project_id,
      filter: [],
      searchQuery: undefined,
      orderBy: { column: "timestamp", order: "DESC" },
      limit: 2,
      page: 0,
    });

    expect(tableRows).toHaveLength(2);
    expect(tableRows[0].id).toEqual(`${trace_id}-1`);
    expect(tableRows[1].id).toEqual(`${trace_id}-2`);
  });

  it("should get a correct trace with observations", async () => {
    const project_id = v4().replace(/-/g, "");
    const trace_id = v4();

    const trace = createTrace({ id: trace_id, project_id });
    await createTracesCh([trace]);

    const obs1 = createObservation({ trace_id, project_id });
    const obs2 = createObservation({ trace_id, project_id });
    await createObservationsCh([obs1, obs2]);

    const tableRows = await getTracesTable({
      projectId: project_id,
      filter: [],
      searchQuery: undefined,
      orderBy: undefined,
      limit: 1,
      page: 0,
    });

    expect(tableRows).toHaveLength(1);
    expect(tableRows[0].id).toEqual(trace_id);
    expect(tableRows[0].projectId).toEqual(project_id);
    expect(tableRows[0].tags.sort()).toEqual(trace.tags.sort());
    expect(tableRows[0].name).toEqual(trace.name);
    expect(tableRows[0].bookmarked).toEqual(trace.bookmarked);
    expect(tableRows[0].release).toEqual(trace.release);
    expect(tableRows[0].version).toEqual(trace.version);
    expect(tableRows[0].userId).toEqual(trace.user_id);
    expect(tableRows[0].sessionId).toEqual(trace.session_id);
    expect(tableRows[0].public).toEqual(trace.public);
  });

  type TestCase = {
    traceInput: Partial<TraceRecordInsertType>;
    observationInput: Partial<ObservationRecordInsertType>[];
    filterstate: FilterState;
    expected: Partial<TracesTableUiReturnType>[];
  };

  [
    {
      traceInput: {},
      observationInput: [
        { cost_details: { total: 100 } },
        { cost_details: { total: 200 } },
      ],
      filterstate: [
        {
          column: "totalCost",
          operator: ">" as const,
          value: 100000,
          type: "number" as const,
        },
      ],
      expected: [],
    },
    {
      traceInput: {},
      observationInput: [
        { usage_details: { total: 100 } },
        { usage_details: { total: 200 } },
      ],
      filterstate: [
        {
          column: "totalTokens",
          operator: ">" as const,
          value: 3456789,
          type: "number" as const,
        },
      ],
      expected: [],
    },
    {
      traceInput: {},
      observationInput: [],
      filterstate: [
        {
          column: "id",
          operator: "=" as const,
          value: "some-id",
          type: "string" as const,
        },
      ],
      expected: [],
    },
    {
      traceInput: {},
      observationInput: [],
      filterstate: [
        {
          column: "Latency (s)",
          operator: ">" as const,
          value: 5_000_000, // Verify that we can pass large values
          type: "number" as const,
        },
      ],
      expected: [],
    },
  ].forEach(async (testConfig: TestCase) => {
    it(`should get a correct trace with filters ${JSON.stringify(testConfig)}`, async () => {
      const project_id = v4().replace(/-/g, "");
      const trace_id = v4();

      const trace = createTrace({
        id: trace_id,
        project_id,
        ...testConfig.traceInput,
      });
      await createTracesCh([trace]);

      expect(testConfig.observationInput.length).not.toBeGreaterThan(2);

      const obs1 = createObservation({
        trace_id,
        project_id,
        ...(testConfig.observationInput.length > 0
          ? testConfig.observationInput[0]
          : {}),
      });
      const obs2 = createObservation({
        trace_id,
        project_id,
        ...(testConfig.observationInput.length > 1
          ? testConfig.observationInput[1]
          : {}),
      });
      await createObservationsCh([obs1, obs2]);

      const tableRows = await getTracesTable({
        projectId: project_id,
        filter: testConfig.filterstate,
        searchQuery: undefined,
        orderBy: undefined,
        limit: 1,
        page: 0,
      });

      expect(tableRows).toHaveLength(testConfig.expected.length);
      testConfig.expected.forEach((expectedTrace, index) => {
        if (expectedTrace.id !== undefined) {
          expect(tableRows[index].id).toEqual(expectedTrace.id);
        }
        if (expectedTrace.projectId !== undefined) {
          expect(tableRows[index].projectId).toEqual(expectedTrace.projectId);
        }
        if (expectedTrace.tags !== undefined) {
          expect(tableRows[index].tags).toEqual(expectedTrace.tags);
        }
        if (expectedTrace.name !== undefined) {
          expect(tableRows[index].name).toEqual(expectedTrace.name);
        }
        if (expectedTrace.bookmarked !== undefined) {
          expect(tableRows[index].bookmarked).toEqual(expectedTrace.bookmarked);
        }
        if (expectedTrace.release !== undefined) {
          expect(tableRows[index].release).toEqual(expectedTrace.release);
        }
        if (expectedTrace.version !== undefined) {
          expect(tableRows[index].version).toEqual(expectedTrace.version);
        }
        if (expectedTrace.userId !== undefined) {
          expect(tableRows[index].userId).toEqual(expectedTrace.userId);
        }
        if (expectedTrace.sessionId !== undefined) {
          expect(tableRows[index].sessionId).toEqual(expectedTrace.sessionId);
        }
        if (expectedTrace.public !== undefined) {
          expect(tableRows[index].public).toEqual(expectedTrace.public);
        }
      });
    });
  });

  describe("observation count", () => {
    // One trace with a root span and one child: both are observations.
    const seedTraceWithRootAndChild = async () => {
      const projectId = v4().replace(/-/g, "");
      const traceId = v4();
      const rootId = v4();
      await createTracesCh([
        createTrace({ id: traceId, project_id: projectId }),
      ]);
      await createObservationsCh([
        createObservation({
          id: rootId,
          trace_id: traceId,
          project_id: projectId,
          parent_observation_id: null,
        }),
        createObservation({
          trace_id: traceId,
          project_id: projectId,
          parent_observation_id: rootId,
        }),
      ]);
      return { projectId, traceId };
    };

    it("counts the root span on the id-scoped metrics path", async () => {
      const { projectId, traceId } = await seedTraceWithRootAndChild();

      const metrics = await getTracesTableMetrics({
        projectId,
        filter: [
          {
            column: "id",
            type: "stringOptions",
            operator: "any of",
            value: [traceId],
          },
        ],
      });

      expect(metrics).toHaveLength(1);
      expect(metrics[0].observationCount).toBe(BigInt(2));
    });

    it("counts the root span on the general metrics path", async () => {
      const { projectId } = await seedTraceWithRootAndChild();

      const metrics = await getTracesTableMetrics({ projectId, filter: [] });

      expect(metrics).toHaveLength(1);
      expect(metrics[0].observationCount).toBe(BigInt(2));
    });
  });
});
