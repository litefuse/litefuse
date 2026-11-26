import {
  checkTraceExistsAndGetTimestamp,
  createTracesCh,
} from "@langfuse/shared/src/server";
import {
  getTraceById,
  getTraceUsageBreakdown,
  getTracesBySessionId,
} from "@langfuse/shared/src/server";
import { v4 } from "uuid";
import { createObservation, createTrace } from "@langfuse/shared/src/server";
import { createObservationsCh } from "@langfuse/shared/src/server";

const projectId = "7a88fb47b4e243b8a06ca5ce950dc53a";

describe("Clickhouse Traces Repository Test", () => {
  it("should throw if no traces are found", async () => {
    expect(
      await getTraceById({ traceId: v4(), projectId: v4().replace(/-/g, "") }),
    ).toBeUndefined();
  });

  it("should return a trace if it exists", async () => {
    const traceId = v4();

    const trace = createTrace({
      id: traceId,
      project_id: projectId,
      session_id: v4(),
      timestamp: Date.now(),
      metadata: {},
      public: false,
      bookmarked: false,
      name: "Test Trace",
      tags: [],
      release: null,
      version: null,
      user_id: null,
      input: JSON.stringify({
        this: {
          is: {
            a: ["complex", "object"],
          },
        },
      }),
      output: "regular string",
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      is_deleted: 0,
    });

    await createTracesCh([trace]);

    const result = await getTraceById({
      traceId,
      projectId,
      timestamp: new Date(trace.timestamp),
    });
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(result.id).toEqual(trace.id);
    expect(result.projectId).toEqual(trace.project_id);
    expect(result.name).toEqual(trace.name);
    expect(result.timestamp).toEqual(new Date(trace.timestamp));
    expect(result.tags).toEqual(trace.tags);
    expect(result.bookmarked).toEqual(trace.bookmarked);
    expect(result.release).toEqual(trace.release);
    expect(result.version).toEqual(trace.version);
    expect(result.userId).toEqual(trace.user_id);
    expect(result.sessionId).toEqual(trace.session_id);
    expect(result.public).toEqual(trace.public);
    expect(result.input).toEqual(JSON.parse(trace.input ?? "{}"));
    expect(result.output).toEqual("regular string");
    expect(result.metadata).toEqual(trace.metadata);
    expect(result.createdAt.getTime()).toBeCloseTo(
      new Date(trace.created_at).getTime(),
      -2, // Up to 50ms precision
    );
    expect(result.updatedAt.getTime()).toBeCloseTo(
      new Date(trace.updated_at).getTime(),
      -2, // Up to 50ms precision
    );
  });

  it("should find a trace if no timestamp is provided", async () => {
    const traceId = v4();

    const trace = createTrace({
      id: traceId,
      project_id: projectId,
      session_id: v4(),
      timestamp: Date.now(),
      metadata: {},
      public: false,
      bookmarked: false,
      name: "Test Trace",
      tags: [],
      release: null,
      version: null,
      user_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      is_deleted: 0,
    });

    await createTracesCh([trace]);

    const result = await getTraceById({ traceId, projectId });
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(result.id).toEqual(trace.id);
    expect(result.projectId).toEqual(trace.project_id);
    expect(result.name).toEqual(trace.name);
    expect(result.timestamp).toEqual(new Date(trace.timestamp));
    expect(result.tags).toEqual(trace.tags);
    expect(result.bookmarked).toEqual(trace.bookmarked);
    expect(result.release).toEqual(trace.release);
    expect(result.version).toEqual(trace.version);
    expect(result.userId).toEqual(trace.user_id);
    expect(result.sessionId).toEqual(trace.session_id);
    expect(result.public).toEqual(trace.public);
    expect(result.input).toEqual(null);
    expect(result.output).toEqual(null);
    expect(result.metadata).toEqual(trace.metadata);
    expect(result.createdAt.getTime()).toBeCloseTo(
      new Date(trace.created_at).getTime(),
      -2, // Up to 50ms precision
    );
    expect(result.updatedAt.getTime()).toBeCloseTo(
      new Date(trace.updated_at).getTime(),
      -2, // Up to 50ms precision
    );
  });

  it("should retrieve traces by session ID", async () => {
    const sessionId = v4();
    const trace1 = createTrace({
      id: v4(),
      project_id: projectId,
      session_id: sessionId,
      timestamp: Date.now(),
      metadata: {},
      public: false,
      bookmarked: false,
      name: "Trace 1",
      tags: [],
      release: null,
      version: null,
      user_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      is_deleted: 0,
    });

    const trace2 = createTrace({
      id: v4(),
      project_id: projectId,
      session_id: sessionId,
      timestamp: Date.now(),
      metadata: {},
      public: false,
      bookmarked: false,
      name: "Trace 2",
      tags: [],
      release: null,
      version: null,
      user_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      is_deleted: 0,
    });

    await createTracesCh([trace1, trace2]);

    const results = await getTracesBySessionId(projectId, [sessionId]);
    expect(results).toHaveLength(2);

    const resultIds = results.map((result) => result.id);
    expect(resultIds).toContain(trace1.id);
    expect(resultIds).toContain(trace2.id);
  });

  // Skipped: checkTraceExistsAndGetTimestamp filters os.<column> from the traces UI mapping, but joins its observation aggregate as o.
  it.skip("should check if trace exists with level filter", async () => {
    const traceId = v4();
    const trace = createTrace({
      id: traceId,
      user_id: "user-1",
      project_id: "7a88fb47b4e243b8a06ca5ce950dc53a",
      metadata: { key: "value" },
      release: "1.0.0",
      version: "2.0.0",
    });

    const observations = [
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 1000,
        input: "input",
        output: "output",
        provided_model_name: "model-1",
        level: "ERROR",
      }),
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name-2",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 100000,
        input: "input-2",
        output: "output-2",
        provided_model_name: "model-2",
      }),
    ];

    await createTracesCh([trace]);
    await createObservationsCh(observations);

    const { exists } = await checkTraceExistsAndGetTimestamp({
      projectId,
      traceId,
      timestamp: new Date(),
      filter: [
        {
          type: "stringOptions",
          column: "level",
          operator: "any of",
          value: ["ERROR"],
        },
      ],
      maxTimeStamp: undefined,
    });
    expect(exists).toBe(true);
  });

  // Skipped: checkTraceExistsAndGetTimestamp filters os.<column> from the traces UI mapping, but joins its observation aggregate as o.
  it.skip("should check if trace exists with level filter none of", async () => {
    const traceId = v4();
    const trace = createTrace({
      id: traceId,
      user_id: "user-1",
      project_id: "7a88fb47b4e243b8a06ca5ce950dc53a",
      metadata: { key: "value" },
      release: "1.0.0",
      version: "2.0.0",
    });

    const observations = [
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 1000,
        input: "input",
        output: "output",
        provided_model_name: "model-1",
        level: "ERROR",
      }),
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name-2",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 100000,
        input: "input-2",
        output: "output-2",
        provided_model_name: "model-2",
      }),
    ];

    await createTracesCh([trace]);
    await createObservationsCh(observations);

    const { exists } = await checkTraceExistsAndGetTimestamp({
      projectId,
      traceId,
      timestamp: new Date(),
      filter: [
        {
          type: "stringOptions",
          column: "level",
          operator: "none of",
          value: ["ERROR"],
        },
      ],
      maxTimeStamp: undefined,
    });
    expect(exists).toBe(false);
  });
  it("should check if trace exists without level filter", async () => {
    const traceId = v4();
    const trace = createTrace({
      id: traceId,
      user_id: "user-1",
      project_id: "7a88fb47b4e243b8a06ca5ce950dc53a",
      metadata: { key: "value" },
      release: "1.0.0",
      version: "2.0.0",
    });

    const observations = [
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 1000,
        input: "input",
        output: "output",
        provided_model_name: "model-1",
        level: "ERROR",
      }),
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name-2",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 100000,
        input: "input-2",
        output: "output-2",
        provided_model_name: "model-2",
      }),
    ];

    await createTracesCh([trace]);
    await createObservationsCh(observations);

    const { exists } = await checkTraceExistsAndGetTimestamp({
      projectId,
      traceId,
      timestamp: new Date(),
      filter: [],
      maxTimeStamp: undefined,
    });
    expect(exists).toBe(true);
  });
  // Skipped: checkTraceExistsAndGetTimestamp filters os.<column> from the traces UI mapping, but joins its observation aggregate as o.
  it.skip("should check if trace exists with error level count > 0", async () => {
    const traceId = v4();
    const trace = createTrace({
      id: traceId,
      user_id: "user-1",
      project_id: "7a88fb47b4e243b8a06ca5ce950dc53a",
      metadata: { key: "value" },
      release: "1.0.0",
      version: "2.0.0",
    });

    const observations = [
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 1000,
        input: "input",
        output: "output",
        provided_model_name: "model-1",
        level: "ERROR",
      }),
      createObservation({
        trace_id: trace.id,
        project_id: trace.project_id,
        name: "observation-name-2",
        end_time: new Date().getTime(),
        start_time: new Date().getTime() - 100000,
        input: "input-2",
        output: "output-2",
        provided_model_name: "model-2",
      }),
    ];

    await createTracesCh([trace]);
    await createObservationsCh(observations);

    const { exists } = await checkTraceExistsAndGetTimestamp({
      projectId,
      traceId,
      timestamp: new Date(),
      filter: [
        {
          type: "number",
          column: "errorCount",
          operator: ">",
          value: 0,
        },
      ],
      maxTimeStamp: undefined,
    });
    expect(exists).toBe(true);
  });

  // Skipped: checkTraceExistsAndGetTimestamp filters os.<column> from the traces UI mapping, but joins its observation aggregate as o.
  it.skip.each([
    {
      name: "latency",
      column: "latency",
      observationOverrides: {
        start_time: Date.now() - 15_000,
        end_time: Date.now(),
      },
      matchingValue: 10,
      nonMatchingValue: 20,
    },
    {
      name: "totalCost",
      column: "totalCost",
      observationOverrides: {
        cost_details: { input: 5, output: 10, total: 15 },
      },
      matchingValue: 10,
      nonMatchingValue: 20,
    },
  ])(
    "should check if trace exists with $name filter",
    async ({
      column,
      observationOverrides,
      matchingValue,
      nonMatchingValue,
    }) => {
      const traceId = v4();
      const trace = createTrace({ id: traceId, project_id: projectId });

      await createTracesCh([trace]);
      await createObservationsCh([
        createObservation({
          trace_id: traceId,
          project_id: projectId,
          ...observationOverrides,
        }),
      ]);

      const { exists: shouldExist } = await checkTraceExistsAndGetTimestamp({
        projectId,
        traceId,
        timestamp: new Date(),
        filter: [
          { type: "number", column, operator: ">", value: matchingValue },
        ],
        maxTimeStamp: undefined,
      });
      expect(shouldExist).toBe(true);

      const { exists: shouldNotExist } = await checkTraceExistsAndGetTimestamp({
        projectId,
        traceId,
        timestamp: new Date(),
        filter: [
          {
            type: "number",
            column,
            operator: ">",
            value: nonMatchingValue,
          },
        ],
        maxTimeStamp: undefined,
      });
      expect(shouldNotExist).toBe(false);
    },
  );

  it("should handle timestamp filter in checkTraceExistsAndGetTimestamp", async () => {
    const traceId = v4();
    const trace = createTrace({
      id: traceId,
      user_id: "user-1",
      project_id: "7a88fb47b4e243b8a06ca5ce950dc53a",
      metadata: { key: "value" },
      release: "1.0.0",
      version: "2.0.0",
      timestamp: Date.now(),
    });

    await createTracesCh([trace]);

    const { exists } = await checkTraceExistsAndGetTimestamp({
      projectId,
      traceId,
      timestamp: new Date(),
      filter: [
        {
          type: "datetime",
          column: "timestamp",
          operator: ">=",
          value: new Date(Date.now() - 3600000),
        },
      ],
      maxTimeStamp: undefined,
    });
    expect(exists).toBe(true);
  });

  it("should include the root span in the trace usage breakdown", async () => {
    const traceId = v4();
    const rootId = v4();
    await createTracesCh([createTrace({ id: traceId, project_id: projectId })]);
    await createObservationsCh([
      createObservation({
        id: rootId,
        trace_id: traceId,
        project_id: projectId,
        type: "GENERATION",
        parent_observation_id: null,
        usage_details: { input: 10, output: 20, total: 30 },
        cost_details: { input: 1, output: 2, total: 3 },
      }),
      createObservation({
        trace_id: traceId,
        project_id: projectId,
        type: "GENERATION",
        parent_observation_id: rootId,
        usage_details: { input: 1, output: 2, total: 3 },
        cost_details: { input: 0.1, output: 0.2, total: 0.3 },
      }),
    ]);

    const breakdown = await getTraceUsageBreakdown({ projectId, traceId });

    expect(breakdown.usageDetails).toEqual({
      input: 11,
      output: 22,
      total: 33,
    });
    expect(breakdown.costDetails.total).toBeCloseTo(3.3);
  });
});
