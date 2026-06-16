import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { JobExecutionStatus } from "@prisma/client";
import {
  processObservationEval,
  type ObservationEvalProcessorDeps,
} from "@/src/server/background/features/evaluation/observationEval/observationEvalProcessor";
import {
  createTestObservation,
  createMockJobExecution,
  createMockJobConfiguration,
  createMockEvalTemplate,
  createMockProcessorDeps,
} from "./fixtures";
import { UnrecoverableError } from "@/src/server/background/errors/UnrecoverableError";

// Mock prisma
vi.mock("@langfuse/shared/src/db", async () => {
  const actual = await vi.importActual("@langfuse/shared/src/db");

  return {
    ...actual,
    prisma: {
      jobExecution: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      jobConfiguration: {
        findFirst: vi.fn(),
      },
    },
  };
});

// Mock executeLLMAsJudgeEvaluation
vi.mock("@/src/server/background/features/evaluation/evalService", () => ({
  executeLLMAsJudgeEvaluation: vi.fn(),
}));

// Mock logger
vi.mock("@langfuse/shared/src/server", async () => {
  const actual = await vi.importActual("@langfuse/shared/src/server");
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    DEFAULT_TRACE_ENVIRONMENT: "default",
  };
});

import { prisma } from "@langfuse/shared/src/db";
import { executeLLMAsJudgeEvaluation } from "@/src/server/background/features/evaluation/evalService";

describe("processObservationEval", () => {
  const projectId = "test-project-123";
  const jobExecutionId = "job-exec-456";
  const spanId = "span-789";
  const startTimeDate = "2026-05-14";

  const baseEvent = {
    projectId,
    jobExecutionId,
    spanId,
    startTimeDate,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("job execution lookup", () => {
    it("should return early when job execution is not found", async () => {
      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(null);

      const deps = createMockProcessorDeps();

      await processObservationEval({ event: baseEvent, deps });

      expect(prisma.jobExecution.findFirst).toHaveBeenCalledWith({
        where: {
          id: jobExecutionId,
          projectId,
        },
      });
      expect(deps.fetchObservation).not.toHaveBeenCalled();
      expect(executeLLMAsJudgeEvaluation).not.toHaveBeenCalled();
    });
  });

  describe("job configuration lookup", () => {
    it("should throw UnrecoverableError when job configuration is not found", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
      });
      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(null);

      const deps = createMockProcessorDeps();

      await expect(
        processObservationEval({ event: baseEvent, deps }),
      ).rejects.toThrow(UnrecoverableError);
      await expect(
        processObservationEval({ event: baseEvent, deps }),
      ).rejects.toThrow("Job configuration or template not found");
    });

    it("should throw UnrecoverableError when evalTemplate is null", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
      });
      const configWithoutTemplate = createMockJobConfiguration({
        id: "config-123",
        projectId,
        evalTemplate: null,
      });

      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(
        configWithoutTemplate,
      );

      const deps = createMockProcessorDeps();

      await expect(
        processObservationEval({ event: baseEvent, deps }),
      ).rejects.toThrow(UnrecoverableError);
    });

    it("should cancel the job when the evaluator is blocked", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
      });
      const config = createMockJobConfiguration({
        id: "config-123",
        projectId,
        blockedAt: new Date(),
      });

      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(config);

      const deps = createMockProcessorDeps();

      await processObservationEval({ event: baseEvent, deps });

      expect(prisma.jobExecution.update).toHaveBeenCalledWith({
        where: {
          id: job.id,
          projectId,
        },
        data: {
          status: JobExecutionStatus.CANCELLED,
          endTime: expect.any(Date),
        },
      });
      expect(deps.fetchObservation).not.toHaveBeenCalled();
      expect(executeLLMAsJudgeEvaluation).not.toHaveBeenCalled();
    });
  });

  describe("Doris fetch", () => {
    it("should retry (non-Unrecoverable) when Doris fetch fails transiently", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
      });
      const config = createMockJobConfiguration({
        id: "config-123",
        projectId,
      });

      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(config);

      const deps: ObservationEvalProcessorDeps = {
        fetchObservation: vi
          .fn()
          .mockRejectedValue(new Error("Doris connection failed")),
      };

      await expect(
        processObservationEval({ event: baseEvent, deps }),
      ).rejects.toThrow("Failed to fetch observation from Doris");
    });

    it("should throw UnrecoverableError when the row is gone", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
      });
      const config = createMockJobConfiguration({
        id: "config-123",
        projectId,
      });

      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(config);

      const deps: ObservationEvalProcessorDeps = {
        fetchObservation: vi.fn().mockResolvedValue(null),
      };

      // Row deleted between scheduling and execution is permanent
      await expect(
        processObservationEval({ event: baseEvent, deps }),
      ).rejects.toThrow(UnrecoverableError);

      expect(deps.fetchObservation).toHaveBeenCalledWith({
        projectId,
        spanId,
        startTimeDate,
        retry: {
          maxAttempts: 7,
          initialDelayMs: 200,
          backoffMultiplier: 2,
          maxDelayMs: 5_000,
        },
      });
    });
  });

  describe("successful execution", () => {
    it("should call executeLLMAsJudgeEvaluation with correct parameters", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
        jobInputTraceId: "trace-abc",
        jobInputObservationId: "obs-xyz",
      });
      const template = createMockEvalTemplate({
        id: "template-456",
        projectId,
        prompt: "Evaluate: {{output}}",
      });
      const config = createMockJobConfiguration({
        id: "config-123",
        projectId,
        evalTemplateId: "template-456",
        variableMapping: [
          { templateVariable: "output", selectedColumnId: "output" },
        ],
        evalTemplate: template,
      });
      const observation = createTestObservation({
        span_id: "obs-xyz",
        project_id: projectId,
        trace_id: "trace-abc",
        environment: "production",
        output: '{"response": "test output"}',
      });

      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(config);

      const deps = createMockProcessorDeps({
        fetchObservation: vi.fn().mockResolvedValue(observation),
      });

      await processObservationEval({ event: baseEvent, deps });

      expect(executeLLMAsJudgeEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          jobExecutionId,
          job: expect.objectContaining({ id: jobExecutionId }),
          config: expect.objectContaining({ id: "config-123" }),
          template: expect.objectContaining({ id: "template-456" }),
          extractedVariables: expect.arrayContaining([
            expect.objectContaining({
              var: "output",
              value: '{"response": "test output"}',
            }),
          ]),
          environment: "production",
        }),
      );
    });

    it("should use default environment when observation environment is null", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
      });
      const config = createMockJobConfiguration({
        id: "config-123",
        projectId,
        variableMapping: [],
      });
      const observation = createTestObservation({
        project_id: projectId,
        environment: undefined as unknown as string,
      });

      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(config);

      const deps = createMockProcessorDeps({
        fetchObservation: vi.fn().mockResolvedValue(observation),
      });

      await processObservationEval({ event: baseEvent, deps });

      expect(executeLLMAsJudgeEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: "default",
        }),
      );
    });

    it("should extract multiple variables from observation", async () => {
      const job = createMockJobExecution({
        id: jobExecutionId,
        projectId,
        status: JobExecutionStatus.PENDING,
        jobConfigurationId: "config-123",
      });
      const config = createMockJobConfiguration({
        id: "config-123",
        projectId,
        variableMapping: [
          { templateVariable: "input", selectedColumnId: "input" },
          { templateVariable: "output", selectedColumnId: "output" },
        ],
      });
      const observation = createTestObservation({
        project_id: projectId,
        input: '{"prompt": "Hello"}',
        output: '{"response": "World"}',
      });

      (prisma.jobExecution.findFirst as Mock).mockResolvedValue(job);
      (prisma.jobConfiguration.findFirst as Mock).mockResolvedValue(config);

      const deps = createMockProcessorDeps({
        fetchObservation: vi.fn().mockResolvedValue(observation),
      });

      await processObservationEval({ event: baseEvent, deps });

      expect(executeLLMAsJudgeEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          extractedVariables: expect.arrayContaining([
            expect.objectContaining({
              var: "input",
              value: '{"prompt": "Hello"}',
            }),
            expect.objectContaining({
              var: "output",
              value: '{"response": "World"}',
            }),
          ]),
        }),
      );
    });
  });
});
