import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EventRecordInsertType } from "@langfuse/shared";
import { scheduleDirectObservationEvals } from "@/src/server/background/features/evaluation/observationEval";
import { createTestEvalConfig } from "./fixtures";

const mocks = vi.hoisted(() => ({
  fetchObservationEvalConfigsMock: vi.fn(),
  scheduleObservationEvalsMock: vi.fn(),
  createObservationEvalSchedulerDepsMock: vi.fn(),
  traceExceptionMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock(
  "@/src/server/background/features/evaluation/observationEval/fetchObservationEvalConfigs",
  () => ({
    fetchObservationEvalConfigs: mocks.fetchObservationEvalConfigsMock,
  }),
);

vi.mock(
  "@/src/server/background/features/evaluation/observationEval/scheduleObservationEvals",
  () => ({
    scheduleObservationEvals: mocks.scheduleObservationEvalsMock,
  }),
);

vi.mock(
  "@/src/server/background/features/evaluation/observationEval/createSchedulerDeps",
  () => ({
    createObservationEvalSchedulerDeps:
      mocks.createObservationEvalSchedulerDepsMock,
  }),
);

vi.mock("@langfuse/shared/src/server", async () => {
  const actual = await vi.importActual("@langfuse/shared/src/server");
  return {
    ...actual,
    traceException: mocks.traceExceptionMock,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mocks.loggerErrorMock,
    },
  };
});

const createEventRecord = (
  overrides: Partial<EventRecordInsertType> = {},
): EventRecordInsertType => ({
  id: "span-1",
  org_id: null,
  project_id: "project-1",
  trace_id: "trace-1",
  span_id: "span-1",
  parent_span_id: "",
  name: "completion",
  type: "GENERATION",
  environment: "default",
  version: null,
  release: null,
  trace_name: "trace-name",
  user_id: "user-1",
  session_id: "session-1",
  tags: ["tag-1"],
  bookmarked: false,
  public: false,
  level: "DEFAULT",
  status_message: null,
  prompt_id: null,
  prompt_name: null,
  prompt_version: null,
  model_id: null,
  provided_model_name: "gpt-4o-mini",
  model_parameters: '{"temperature":0}',
  provided_usage_details: {},
  usage_details: {},
  provided_cost_details: {},
  cost_details: {},
  usage_pricing_tier_id: null,
  usage_pricing_tier_name: null,
  tool_definitions: {},
  tool_calls: [],
  tool_call_names: [],
  input: '{"input":"hi"}',
  output: '{"output":"hello"}',
  metadata_names: ["tier", "tenant"],
  metadata_values: ["prod", "acme"],
  experiment_id: null,
  experiment_name: null,
  experiment_metadata_names: [],
  experiment_metadata_values: [],
  experiment_description: null,
  experiment_dataset_id: null,
  experiment_item_id: null,
  experiment_item_version: null,
  experiment_item_expected_output: null,
  experiment_item_metadata_names: [],
  experiment_item_metadata_values: [],
  experiment_item_root_span_id: null,
  source: "api",
  service_name: null,
  service_version: null,
  scope_name: null,
  scope_version: null,
  telemetry_sdk_language: null,
  telemetry_sdk_name: null,
  telemetry_sdk_version: null,
  blob_storage_file_path: "",
  event_bytes: 1,
  is_deleted: 0,
  total_cost: null,
  start_time: Date.parse("2026-05-29T12:34:56.000Z"),
  end_time: null,
  completion_start_time: null,
  created_at: Date.parse("2026-05-29T12:34:56.000Z"),
  updated_at: Date.parse("2026-05-29T12:34:56.000Z"),
  event_ts: Date.parse("2026-05-29T12:34:56.000Z"),
  ...overrides,
});

describe("scheduleDirectObservationEvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createObservationEvalSchedulerDepsMock.mockReturnValue({
      upsertJobExecution: vi.fn(),
      enqueueEvalJob: vi.fn(),
    });
  });

  it("does nothing when the project has no eval configs", async () => {
    mocks.fetchObservationEvalConfigsMock.mockResolvedValue([]);

    await scheduleDirectObservationEvals([
      {
        eventRecord: createEventRecord(),
        startTimeDate: "2026-05-29",
      },
    ]);

    expect(mocks.fetchObservationEvalConfigsMock).toHaveBeenCalledWith(
      "project-1",
    );
    expect(mocks.createObservationEvalSchedulerDepsMock).not.toHaveBeenCalled();
    expect(mocks.scheduleObservationEvalsMock).not.toHaveBeenCalled();
  });

  it("converts event record metadata and schedules matching configs", async () => {
    const config = createTestEvalConfig({ projectId: "project-1" });
    const schedulerDeps = {
      upsertJobExecution: vi.fn(),
      enqueueEvalJob: vi.fn(),
    };
    mocks.fetchObservationEvalConfigsMock.mockResolvedValue([config]);
    mocks.createObservationEvalSchedulerDepsMock.mockReturnValue(schedulerDeps);

    await scheduleDirectObservationEvals([
      {
        eventRecord: createEventRecord(),
        startTimeDate: "2026-05-29",
      },
    ]);

    expect(mocks.createObservationEvalSchedulerDepsMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.scheduleObservationEvalsMock).toHaveBeenCalledWith({
      observation: expect.objectContaining({
        project_id: "project-1",
        span_id: "span-1",
        metadata: {
          tier: "prod",
          tenant: "acme",
        },
      }),
      startTimeDate: "2026-05-29",
      configs: [config],
      schedulerDeps,
    });
  });

  it("continues scheduling after one candidate fails", async () => {
    const config = createTestEvalConfig({ projectId: "project-1" });
    mocks.fetchObservationEvalConfigsMock.mockResolvedValue([config]);
    mocks.scheduleObservationEvalsMock
      .mockRejectedValueOnce(new Error("bad candidate"))
      .mockResolvedValueOnce(undefined);

    await scheduleDirectObservationEvals([
      {
        eventRecord: createEventRecord({ span_id: "span-1", id: "span-1" }),
        startTimeDate: "2026-05-29",
      },
      {
        eventRecord: createEventRecord({ span_id: "span-2", id: "span-2" }),
        startTimeDate: "2026-05-29",
      },
    ]);

    expect(mocks.scheduleObservationEvalsMock).toHaveBeenCalledTimes(2);
    expect(mocks.traceExceptionMock).toHaveBeenCalledTimes(1);
    expect(mocks.loggerErrorMock).toHaveBeenCalledWith(
      "Failed to schedule direct observation eval",
      expect.objectContaining({
        projectId: "project-1",
        spanId: "span-1",
        startTimeDate: "2026-05-29",
      }),
    );
  });

  it("groups candidates by project before loading configs", async () => {
    const project1Config = createTestEvalConfig({ projectId: "project-1" });
    const project2Config = createTestEvalConfig({ projectId: "project-2" });

    mocks.fetchObservationEvalConfigsMock.mockImplementation(
      async (projectId: string) =>
        projectId === "project-1" ? [project1Config] : [project2Config],
    );

    await scheduleDirectObservationEvals([
      {
        eventRecord: createEventRecord({ project_id: "project-1" }),
        startTimeDate: "2026-05-29",
      },
      {
        eventRecord: createEventRecord({
          project_id: "project-2",
          span_id: "span-2",
          id: "span-2",
          trace_id: "trace-2",
        }),
        startTimeDate: "2026-05-29",
      },
    ]);

    expect(mocks.fetchObservationEvalConfigsMock).toHaveBeenNthCalledWith(
      1,
      "project-1",
    );
    expect(mocks.fetchObservationEvalConfigsMock).toHaveBeenNthCalledWith(
      2,
      "project-2",
    );
    expect(mocks.scheduleObservationEvalsMock).toHaveBeenCalledTimes(2);
    expect(mocks.scheduleObservationEvalsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        observation: expect.objectContaining({ project_id: "project-1" }),
        configs: [project1Config],
      }),
    );
    expect(mocks.scheduleObservationEvalsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        observation: expect.objectContaining({ project_id: "project-2" }),
        configs: [project2Config],
      }),
    );
  });

  it("logs per-candidate scheduling failures without dropping the rest of the batch", async () => {
    const config = createTestEvalConfig({ projectId: "project-1" });
    mocks.fetchObservationEvalConfigsMock.mockResolvedValue([config]);
    mocks.scheduleObservationEvalsMock.mockImplementation(
      async ({ observation }: { observation: { span_id: string } }) => {
        if (observation.span_id === "span-1") {
          throw new Error("bad candidate");
        }
      },
    );

    await scheduleDirectObservationEvals([
      {
        eventRecord: createEventRecord({ span_id: "span-1", id: "span-1" }),
        startTimeDate: "2026-05-29",
      },
      {
        eventRecord: createEventRecord({
          span_id: "span-2",
          id: "span-2",
          metadata_names: ["tier"],
          metadata_values: ["prod"],
        }),
        startTimeDate: "2026-05-29",
      },
    ]);

    expect(mocks.scheduleObservationEvalsMock).toHaveBeenCalledTimes(2);
    expect(mocks.traceExceptionMock).toHaveBeenCalledTimes(1);
    expect(mocks.loggerErrorMock).toHaveBeenCalledWith(
      "Failed to schedule direct observation eval",
      expect.objectContaining({
        projectId: "project-1",
        spanId: "span-1",
      }),
    );
  });
});
