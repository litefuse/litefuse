import { describe, it, expect, vi, beforeEach } from "vitest";
import { scheduleObservationEvals } from "../scheduleObservationEvals";
import {
  type ObservationForEval,
  type ObservationEvalConfig,
  type EvaluationRuleWithAssignments,
  type ObservationEvalSchedulerDeps,
} from "../types";
import { type Prisma } from "@langfuse/shared/src/db";
import {
  EvalTargetObject,
  JobConfigState,
  JobExecutionStatus,
} from "@langfuse/shared";
import { createW3CTraceId } from "../../../utils";

describe("scheduleObservationEvals", () => {
  const createMockObservation = (
    overrides: Partial<ObservationForEval> = {},
  ): ObservationForEval => ({
    // Core identifiers (snake_case)
    span_id: "obs-123",
    trace_id: "trace-456",
    project_id: "project-789",
    parent_span_id: null,

    // Observation properties
    type: "GENERATION",
    name: "chat-completion",
    environment: "production",
    level: "DEFAULT",
    status_message: null,
    version: "v1.0",

    // Trace-level properties
    trace_name: "my-trace",
    user_id: "user-abc",
    session_id: "session-xyz",
    is_root: false,
    tags: ["tag1", "tag2"],
    release: "v2.0.0",

    // Model properties
    provided_model_name: "gpt-4",
    model_parameters: '{"temperature": 0.7}',

    // Prompt properties
    prompt_id: null,
    prompt_name: null,
    prompt_version: null,

    // Tool call properties
    tool_definitions: {},
    tool_calls: [],
    tool_call_names: [],

    // Usage & Cost
    usage_details: { input: 100, output: 50 },
    cost_details: {},
    provided_usage_details: {},
    provided_cost_details: {},

    // Experiment properties
    experiment_id: null,
    experiment_name: null,
    experiment_description: null,
    experiment_dataset_id: null,
    experiment_item_id: null,
    experiment_item_expected_output: null,

    // Data fields
    input: '{"prompt": "Hello"}',
    output: '{"response": "World"}',
    metadata: { key1: "value1" },
    ...overrides,
  });

  const createMockConfig = (
    overrides: Partial<ObservationEvalConfig> = {},
  ): ObservationEvalConfig => ({
    id: "config-1",
    projectId: "project-789",
    filter: [],
    sampling: { toNumber: () => 1 } as unknown as Prisma.Decimal,
    evalTemplateId: "template-1",
    scoreName: "quality",
    variableMapping: [],
    targetObject: EvalTargetObject.EVENT,
    status: JobConfigState.ACTIVE,
    blockedAt: null,
    ...overrides,
  });

  const createMockSchedulerDeps = (): ObservationEvalSchedulerDeps => ({
    upsertJobExecution: vi.fn().mockResolvedValue({ id: "job-exec-1" }),
    uploadObservationToS3: vi
      .fn()
      .mockResolvedValue("observations/project-789/obs-123.json"),
    enqueueEvalJob: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("empty configs", () => {
    it("should return early when configs array is empty", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.upsertJobExecution).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });
  });

  describe("executability", () => {
    it("should skip paused and inactive configs before uploading to S3", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({
            id: "paused-config",
            blockedAt: new Date(),
          }),
          createMockConfig({
            id: "inactive-config",
            status: JobConfigState.INACTIVE,
          }),
        ],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.upsertJobExecution).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });
  });

  describe("evaluator v2 rules", () => {
    const createMockRule = (
      overrides: Partial<EvaluationRuleWithAssignments> = {},
    ): EvaluationRuleWithAssignments => ({
      id: "rule-1",
      ruleId: "rule-1",
      projectId: "project-789",
      filter: [],
      sampling: { toNumber: () => 1 } as unknown as Prisma.Decimal,
      status: JobConfigState.ACTIVE,
      // Already canonicalized to `event` by fetchObservationEvalConfigs.
      targetObject: EvalTargetObject.EVENT,
      assignments: [
        {
          id: "assignment-1",
          evaluatorId: "evaluator-1",
          variableMapping: [
            { templateVariable: "output", selectedColumnId: "output" },
          ],
          evaluator: {
            id: "evaluator-1",
            projectId: "project-789",
            type: "LLM_AS_JUDGE",
          },
        },
      ],
      ...overrides,
    });

    it("schedules one job per assignment, each carrying its own identity", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockRule({
            assignments: [
              {
                id: "assignment-1",
                evaluatorId: "evaluator-1",
                variableMapping: null,
                evaluator: {
                  id: "evaluator-1",
                  projectId: "project-789",
                  type: "LLM_AS_JUDGE",
                },
              },
              {
                id: "assignment-2",
                evaluatorId: "evaluator-2",
                variableMapping: [
                  { templateVariable: "output", selectedColumnId: "output" },
                ],
                evaluator: {
                  id: "evaluator-2",
                  projectId: "project-789",
                  type: "DECISION_MODEL",
                },
              },
            ],
          }),
        ],
        schedulerDeps,
      });

      // One S3 upload, two executions.
      expect(schedulerDeps.uploadObservationToS3).toHaveBeenCalledTimes(1);
      expect(schedulerDeps.upsertJobExecution).toHaveBeenCalledTimes(2);
      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalledTimes(2);

      const enqueued = vi
        .mocked(schedulerDeps.enqueueEvalJob)
        .mock.calls.map(([params]) => params);
      expect(enqueued[0]).toMatchObject({
        evaluatorId: "evaluator-1",
        evaluationRuleId: "rule-1",
        evalTemplateType: "LLM_AS_JUDGE",
      });
      expect(enqueued[1]).toMatchObject({
        evaluatorId: "evaluator-2",
        evaluationRuleId: "rule-1",
        evalTemplateType: "DECISION_MODEL",
        // Only the second assignment overrides the mapping.
        variableMapping: [
          { templateVariable: "output", selectedColumnId: "output" },
        ],
      });

      // Distinct deterministic ids: the assignment id is part of the key, so the
      // two evaluators of one rule do not collide on the same job execution.
      const ids = enqueued.map((params) => params.jobExecutionId);
      expect(ids[0]).not.toBe(ids[1]);

      // A v2 job pins no template: the executor resolves the version at pickup.
      expect(
        vi.mocked(schedulerDeps.upsertJobExecution).mock.calls[0]![0],
      ).toMatchObject({
        jobConfigurationId: "rule-1",
        jobTemplateId: null,
      });
    });

    it("skips a rule whose assignments were all filtered out", async () => {
      const schedulerDeps = createMockSchedulerDeps();

      await scheduleObservationEvals({
        observation: createMockObservation(),
        configs: [createMockRule({ assignments: [] })],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });

    it("skips an inactive rule", async () => {
      const schedulerDeps = createMockSchedulerDeps();

      await scheduleObservationEvals({
        observation: createMockObservation(),
        configs: [createMockRule({ status: JobConfigState.INACTIVE })],
        schedulerDeps,
      });

      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });

    it("samples a v2 rule out before uploading the observation", async () => {
      const schedulerDeps = createMockSchedulerDeps();

      await scheduleObservationEvals({
        observation: createMockObservation(),
        configs: [
          createMockRule({
            sampling: { toNumber: () => 0 } as unknown as Prisma.Decimal,
          }),
        ],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });
  });

  describe("loop safeguard", () => {
    it("does not schedule anything for internal langfuse environments", async () => {
      const schedulerDeps = createMockSchedulerDeps();

      await scheduleObservationEvals({
        observation: createMockObservation({
          environment: "langfuse-llm-as-a-judge",
        }),
        configs: [createMockConfig({ id: "config-1" })],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });

    it("schedules the root span of a prompt experiment (the sanctioned target)", async () => {
      const schedulerDeps = createMockSchedulerDeps();

      await scheduleObservationEvals({
        observation: createMockObservation({
          environment: "langfuse-prompt-experiment",
          span_id: "root-span",
          experiment_item_root_span_id: "root-span",
        }),
        configs: [createMockConfig({ id: "config-1" })],
        schedulerDeps,
      });

      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalledTimes(1);
    });

    it("skips the non-root spans of a prompt experiment", async () => {
      const schedulerDeps = createMockSchedulerDeps();

      await scheduleObservationEvals({
        observation: createMockObservation({
          environment: "langfuse-prompt-experiment",
          span_id: "child-span",
          experiment_item_root_span_id: "root-span",
        }),
        configs: [createMockConfig({ id: "config-1" })],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });
  });

  describe("S3 upload", () => {
    it("should upload observation to S3 once when configs exist", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [createMockConfig({ id: "config-1" })],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).toHaveBeenCalledTimes(1);
      expect(schedulerDeps.uploadObservationToS3).toHaveBeenCalledWith({
        projectId: "project-789",
        observationId: "obs-123",
        data: observation,
      });
    });

    it("should upload only once even with multiple configs", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({ id: "config-1" }),
          createMockConfig({ id: "config-2" }),
          createMockConfig({ id: "config-3" }),
        ],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).toHaveBeenCalledTimes(1);
    });
  });

  describe("filter evaluation", () => {
    it("should skip config and S3 upload when filter does not match", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation({ type: "span" });

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({
            filter: [
              {
                column: "type",
                type: "stringOptions",
                operator: "any of",
                value: ["generation"],
              },
            ],
          }),
        ],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.upsertJobExecution).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });

    it("should process config when filter matches", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation({ type: "generation" });

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({
            filter: [
              {
                column: "type",
                type: "stringOptions",
                operator: "any of",
                value: ["generation"],
              },
            ],
          }),
        ],
        schedulerDeps,
      });

      expect(schedulerDeps.upsertJobExecution).toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalled();
    });

    it("should process config when filter is empty (matches all)", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [createMockConfig({ filter: [] })],
        schedulerDeps,
      });

      expect(schedulerDeps.upsertJobExecution).toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalled();
    });
  });

  describe("sampling", () => {
    it("should skip config and S3 upload when sampled out (sampling rate 0)", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({
            sampling: { toNumber: () => 0 } as unknown as Prisma.Decimal,
          }),
        ],
        schedulerDeps,
      });

      expect(schedulerDeps.uploadObservationToS3).not.toHaveBeenCalled();
      expect(schedulerDeps.upsertJobExecution).not.toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).not.toHaveBeenCalled();
    });

    it("should process config when sampling rate is 1 (always sample)", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({
            sampling: { toNumber: () => 1 } as unknown as Prisma.Decimal,
          }),
        ],
        schedulerDeps,
      });

      expect(schedulerDeps.upsertJobExecution).toHaveBeenCalled();
      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalled();
    });
  });

  describe("job creation and enqueuing", () => {
    it("should create job execution with correct data", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation();
      const config = createMockConfig();

      await scheduleObservationEvals({
        observation,
        configs: [config],
        schedulerDeps,
      });

      const expectedJobExecutionId = createW3CTraceId(
        `${config.id}:${observation.span_id}`,
      );
      expect(schedulerDeps.upsertJobExecution).toHaveBeenCalledWith({
        id: expectedJobExecutionId,
        projectId: "project-789",
        jobConfigurationId: "config-1",
        jobInputTraceId: "trace-456",
        jobInputObservationId: "obs-123",
        jobTemplateId: config.evalTemplateId,
        status: JobExecutionStatus.PENDING,
      });
    });

    it("should enqueue job with correct parameters", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      schedulerDeps.uploadObservationToS3 = vi
        .fn()
        .mockResolvedValue("observations/project-789/obs-123.json");
      const observation = createMockObservation();
      const config = createMockConfig();

      await scheduleObservationEvals({
        observation,
        configs: [config],
        schedulerDeps,
      });

      const expectedJobExecutionId = createW3CTraceId(
        `${config.id}:${observation.span_id}`,
      );
      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalledWith({
        jobExecutionId: expectedJobExecutionId,
        projectId: "project-789",
        observationS3Path: "observations/project-789/obs-123.json",
        delay: 0,
      });
    });
  });

  describe("multiple configs", () => {
    it("should process multiple matching configs independently", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      schedulerDeps.upsertJobExecution = vi
        .fn()
        .mockResolvedValueOnce({ id: "job-exec-1" })
        .mockResolvedValueOnce({ id: "job-exec-2" })
        .mockResolvedValueOnce({ id: "job-exec-3" });
      const observation = createMockObservation();

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({ id: "config-1" }),
          createMockConfig({ id: "config-2" }),
          createMockConfig({ id: "config-3" }),
        ],
        schedulerDeps,
      });

      // S3 upload only once
      expect(schedulerDeps.uploadObservationToS3).toHaveBeenCalledTimes(1);

      // Job creation for each config
      expect(schedulerDeps.upsertJobExecution).toHaveBeenCalledTimes(3);
      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalledTimes(3);
    });

    it("should skip only non-matching configs", async () => {
      const schedulerDeps = createMockSchedulerDeps();
      const observation = createMockObservation({ type: "generation" });

      await scheduleObservationEvals({
        observation,
        configs: [
          createMockConfig({
            id: "config-1",
            filter: [
              {
                column: "type",
                type: "stringOptions",
                operator: "any of",
                value: ["generation"],
              },
            ],
          }),
          createMockConfig({
            id: "config-2",
            filter: [
              {
                column: "type",
                type: "stringOptions",
                operator: "any of",
                value: ["span"],
              },
            ],
          }),
          createMockConfig({
            id: "config-3",
            filter: [],
          }),
        ],
        schedulerDeps,
      });

      // Should create jobs for config-1 and config-3, but not config-2
      expect(schedulerDeps.upsertJobExecution).toHaveBeenCalledTimes(2);
      expect(schedulerDeps.enqueueEvalJob).toHaveBeenCalledTimes(2);
    });
  });
});
