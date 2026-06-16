import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { randomUUID } from "crypto";
import { scheduleObservationEvals } from "@/src/server/background/features/evaluation/observationEval/scheduleObservationEvals";
import {
  createTestObservation,
  createTestEvalConfig,
  createMockSchedulerDeps,
} from "../features/evaluation/observationEval/__tests__/fixtures";
import { EvalTargetObject } from "@langfuse/shared";
import {
  type ObservationForEval,
  type ObservationEvalConfig,
  type ObservationEvalSchedulerDeps,
} from "@/src/server/background/features/evaluation/observationEval/types";

/**
 * Tests for scheduleObservationEvals handling both observation-level
 * (target_object: "event") and trace-level (target_object: "trace") configs.
 *
 * Key behaviors under test:
 * 1. Observation configs match all spans regardless of parent_span_id.
 * 2. Trace configs only match root spans (parent_span_id is empty or null).
 * 3. enqueueEvalJob is called with the correct targetObject parameter.
 * 4. Trace configs use trace_id in the jobExecutionId (not span_id).
 */

describe("scheduleObservationEvals — trace + observation", () => {
  const projectId = "test-project-123";
  const startTimeDate = "2026-05-21";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── helpers ──────────────────────────────────────────────

  const runSchedule = async (params: {
    observation: ObservationForEval;
    configs: ObservationEvalConfig[];
    deps?: ObservationEvalSchedulerDeps;
  }) => {
    const deps = params.deps ?? createMockSchedulerDeps();
    await scheduleObservationEvals({
      observation: params.observation,
      startTimeDate,
      configs: params.configs,
      schedulerDeps: deps,
    });
    return deps;
  };

  // ── Observation eval (target_object: "event") ─────────────

  describe("observation config (target_object: event)", () => {
    it("matches a child span (non-empty parent_span_id)", async () => {
      const observation = createTestObservation({
        parent_span_id: "some-parent-span",
        project_id: projectId,
      });
      const config = createTestEvalConfig({
        targetObject: EvalTargetObject.EVENT,
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({ observation, configs: [config], deps });

      expect(deps.upsertJobExecution).toHaveBeenCalledTimes(1);
      expect(deps.enqueueEvalJob).toHaveBeenCalledTimes(1);
      expect(deps.enqueueEvalJob).toHaveBeenCalledWith(
        expect.objectContaining({ targetObject: "event" }),
      );
    });

    it("matches a root span (empty parent_span_id)", async () => {
      const observation = createTestObservation({
        parent_span_id: "",
        project_id: projectId,
      });
      const config = createTestEvalConfig({
        targetObject: EvalTargetObject.EVENT,
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({ observation, configs: [config], deps });

      expect(deps.upsertJobExecution).toHaveBeenCalledTimes(1);
      expect(deps.enqueueEvalJob).toHaveBeenCalledWith(
        expect.objectContaining({ targetObject: "event" }),
      );
    });

    it("respects filter — skips when filter does not match", async () => {
      const observation = createTestObservation({
        type: "SPAN",
        project_id: projectId,
      });
      const config = createTestEvalConfig({
        targetObject: EvalTargetObject.EVENT,
        filter: [
          {
            column: "type",
            type: "stringOptions" as const,
            operator: "any of" as const,
            value: ["GENERATION"],
          },
        ],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({ observation, configs: [config], deps });

      expect(deps.upsertJobExecution).not.toHaveBeenCalled();
      expect(deps.enqueueEvalJob).not.toHaveBeenCalled();
    });
  });

  // ── Trace eval (target_object: "trace") ──────────────────

  describe("trace config (target_object: trace)", () => {
    it("matches a root span with empty parent_span_id", async () => {
      const observation = createTestObservation({
        parent_span_id: "",
        project_id: projectId,
      });
      const config = createTestEvalConfig({
        targetObject: EvalTargetObject.TRACE,
        id: "trace-config-1",
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({ observation, configs: [config], deps });

      expect(deps.upsertJobExecution).toHaveBeenCalledTimes(1);
      // Trace eval: should use trace_id for jobExecution dedup
      const upsertCall = (deps.upsertJobExecution as Mock).mock.calls[0][0];
      expect(upsertCall.jobInputObservationId).toBeNull();
      expect(upsertCall.jobInputTraceId).toBe(observation.trace_id);

      expect(deps.enqueueEvalJob).toHaveBeenCalledTimes(1);
      expect(deps.enqueueEvalJob).toHaveBeenCalledWith(
        expect.objectContaining({ targetObject: "trace" }),
      );
    });

    it("matches a root span with null parent_span_id", async () => {
      const observation = createTestObservation({
        parent_span_id: null,
        project_id: projectId,
      });
      const config = createTestEvalConfig({
        targetObject: EvalTargetObject.TRACE,
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({ observation, configs: [config], deps });

      expect(deps.upsertJobExecution).toHaveBeenCalledTimes(1);
      expect(deps.enqueueEvalJob).toHaveBeenCalledWith(
        expect.objectContaining({ targetObject: "trace" }),
      );
    });

    it("does NOT match a non-root span (non-empty parent_span_id)", async () => {
      const observation = createTestObservation({
        parent_span_id: "some-other-span",
        project_id: projectId,
      });
      const config = createTestEvalConfig({
        targetObject: EvalTargetObject.TRACE,
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({ observation, configs: [config], deps });

      expect(deps.upsertJobExecution).not.toHaveBeenCalled();
      expect(deps.enqueueEvalJob).not.toHaveBeenCalled();
    });

    it("respects filter — skips when trace filter does not match", async () => {
      const observation = createTestObservation({
        parent_span_id: "",
        environment: "production",
        project_id: projectId,
      });
      const config = createTestEvalConfig({
        targetObject: EvalTargetObject.TRACE,
        filter: [
          {
            column: "environment",
            type: "stringOptions" as const,
            operator: "any of" as const,
            value: ["staging"],
          },
        ],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({ observation, configs: [config], deps });

      expect(deps.upsertJobExecution).not.toHaveBeenCalled();
      expect(deps.enqueueEvalJob).not.toHaveBeenCalled();
    });
  });

  // ── Mixed configs ────────────────────────────────────────

  describe("mixed obs + trace configs", () => {
    it("schedules both when root span matches both", async () => {
      const observation = createTestObservation({
        parent_span_id: "",
        project_id: projectId,
      });
      const traceConfig = createTestEvalConfig({
        targetObject: EvalTargetObject.TRACE,
        id: "trace-config",
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });
      const obsConfig = createTestEvalConfig({
        targetObject: EvalTargetObject.EVENT,
        id: "obs-config",
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({
        observation,
        configs: [traceConfig, obsConfig],
        deps,
      });

      expect(deps.upsertJobExecution).toHaveBeenCalledTimes(2);
      expect(deps.enqueueEvalJob).toHaveBeenCalledTimes(2);

      // First call: trace config
      expect(deps.enqueueEvalJob).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ targetObject: "trace" }),
      );
      // Second call: obs config
      expect(deps.enqueueEvalJob).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ targetObject: "event" }),
      );
    });

    it("schedules only obs eval when span is a child (trace config filtered out)", async () => {
      const observation = createTestObservation({
        parent_span_id: "parent-123",
        project_id: projectId,
      });
      const traceConfig = createTestEvalConfig({
        targetObject: EvalTargetObject.TRACE,
        id: "trace-config",
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });
      const obsConfig = createTestEvalConfig({
        targetObject: EvalTargetObject.EVENT,
        id: "obs-config",
        filter: [],
        sampling: { toNumber: () => 1 } as any,
      });

      const deps = createMockSchedulerDeps();
      await runSchedule({
        observation,
        configs: [traceConfig, obsConfig],
        deps,
      });

      // Only the obs config should match
      expect(deps.upsertJobExecution).toHaveBeenCalledTimes(1);
      expect(deps.enqueueEvalJob).toHaveBeenCalledTimes(1);
      expect(deps.enqueueEvalJob).toHaveBeenCalledWith(
        expect.objectContaining({ targetObject: "event" }),
      );
    });
  });
});
