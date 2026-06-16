import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { JobExecutionStatus } from "@prisma/client";
import { llmAsJudgeExecutionQueueProcessor } from "@/src/server/background/queues/evalQueue";
import {
  QueueJobs,
  QueueName,
  type TQueueJobTypes,
} from "@langfuse/shared/src/server";
import { UnrecoverableError } from "@/src/server/background/errors/UnrecoverableError";
import type { QueueJobLike } from "@/src/server/background/queues/types";

// Mock prisma
vi.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    jobExecution: {
      update: vi.fn(),
    },
  },
}));

// Mock processObservationEval
vi.mock("@/src/server/background/features/evaluation/observationEval", () => ({
  processObservationEval: vi.fn(),
}));

// Mock logger and span
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
    traceException: vi.fn(),
    getCurrentSpan: vi.fn().mockReturnValue({
      setAttribute: vi.fn(),
    }),
    isLLMCompletionError: vi.fn(),
  };
});

// Mock retryLLMRateLimitError
vi.mock("@/src/server/background/features/utils", () => ({
  createW3CTraceId: vi.fn().mockReturnValue("test-trace-id"),
  retryLLMRateLimitError: vi.fn(),
}));

// Mock isUnrecoverableError
vi.mock("@/src/server/background/errors/UnrecoverableError", async () => {
  const actual = await vi.importActual(
    "@/src/server/background/errors/UnrecoverableError",
  );
  return {
    ...actual,
    isUnrecoverableError: vi.fn(),
  };
});

import { prisma } from "@langfuse/shared/src/db";
import { processObservationEval } from "@/src/server/background/features/evaluation/observationEval";
import {
  isLLMCompletionError,
  traceException,
} from "@langfuse/shared/src/server";
import { retryLLMRateLimitError } from "@/src/server/background/features/utils";
import { isUnrecoverableError } from "@/src/server/background/errors/UnrecoverableError";

describe("llmAsJudgeExecutionQueueProcessor", () => {
  const projectId = "test-project-123";
  const jobExecutionId = "job-exec-456";
  const spanId = "span-789";
  const startTimeDate = "2026-05-14";

  const createMockJob = (
    overrides: Partial<TQueueJobTypes[QueueName.LLMAsJudgeExecution]> = {},
  ): QueueJobLike<QueueName.LLMAsJudgeExecution> => {
    return {
      id: "queue-job-123",
      name: QueueJobs.LLMAsJudgeExecution,
      data: {
        id: "queue-job-123",
        name: QueueJobs.LLMAsJudgeExecution,
        timestamp: new Date(),
        payload: {
          projectId,
          jobExecutionId,
          spanId,
          startTimeDate,
        },
        retryBaggage: {
          attempt: 0,
          originalJobTimestamp: new Date(),
        },
        ...overrides,
      },
      opts: { jobId: "queue-job-123" },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (isLLMCompletionError as Mock).mockReturnValue(false);
    (isUnrecoverableError as Mock).mockReturnValue(false);
  });

  describe("successful processing", () => {
    it("should process observation eval successfully and return true", async () => {
      (processObservationEval as Mock).mockResolvedValue(undefined);

      const job = createMockJob();
      const result = await llmAsJudgeExecutionQueueProcessor(job);

      expect(result).toBe(true);
      expect(processObservationEval).toHaveBeenCalledWith({
        event: {
          projectId,
          jobExecutionId,
          spanId,
          startTimeDate,
        },
      });
    });

    it("should set span attributes for tracing", async () => {
      const mockSpan = { setAttribute: vi.fn() };
      const { getCurrentSpan } = await import("@langfuse/shared/src/server");
      (getCurrentSpan as Mock).mockReturnValue(mockSpan);
      (processObservationEval as Mock).mockResolvedValue(undefined);

      const job = createMockJob();
      await llmAsJudgeExecutionQueueProcessor(job);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "messaging.pgboss.job.input.jobExecutionId",
        jobExecutionId,
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "messaging.pgboss.job.input.projectId",
        projectId,
      );
    });
  });

  describe("LLM rate limit errors (retryable)", () => {
    it("should schedule retry and set DELAYED status for retryable LLM errors", async () => {
      const rateLimitError = new Error("Rate limit exceeded");
      (processObservationEval as Mock).mockRejectedValue(rateLimitError);
      (isLLMCompletionError as Mock).mockReturnValue(true);
      // Mark as retryable
      (rateLimitError as unknown as { isRetryable: boolean }).isRetryable =
        true;

      const job = createMockJob();
      await llmAsJudgeExecutionQueueProcessor(job);

      expect(retryLLMRateLimitError).toHaveBeenCalledWith(
        job,
        expect.objectContaining({
          table: "job_executions",
          idField: "jobExecutionId",
        }),
      );

      expect(prisma.jobExecution.update).toHaveBeenCalledWith({
        where: {
          id: jobExecutionId,
          projectId,
        },
        data: expect.objectContaining({
          status: JobExecutionStatus.DELAYED,
          executionTraceId: "test-trace-id",
        }),
      });
    });

    it("should not rethrow error after scheduling retry", async () => {
      const rateLimitError = new Error("Rate limit exceeded");
      (rateLimitError as unknown as { isRetryable: boolean }).isRetryable =
        true;
      (processObservationEval as Mock).mockRejectedValue(rateLimitError);
      (isLLMCompletionError as Mock).mockReturnValue(true);

      const job = createMockJob();

      // Should not throw
      await expect(
        llmAsJudgeExecutionQueueProcessor(job),
      ).resolves.not.toThrow();
    });
  });

  describe("LLM completion errors (non-retryable)", () => {
    it("should set ERROR status for non-retryable LLM errors", async () => {
      const llmError = new Error("Invalid API key");
      (llmError as unknown as { isRetryable: boolean }).isRetryable = false;
      (processObservationEval as Mock).mockRejectedValue(llmError);
      (isLLMCompletionError as Mock).mockReturnValue(true);

      const job = createMockJob();
      await llmAsJudgeExecutionQueueProcessor(job);

      expect(prisma.jobExecution.update).toHaveBeenCalledWith({
        where: {
          id: jobExecutionId,
          projectId,
        },
        data: expect.objectContaining({
          status: JobExecutionStatus.ERROR,
          endTime: expect.any(Date),
          error: "Invalid API key",
          executionTraceId: "test-trace-id",
        }),
      });
    });

    it("should not rethrow non-retryable LLM errors", async () => {
      const llmError = new Error("Invalid API key");
      (llmError as unknown as { isRetryable: boolean }).isRetryable = false;
      (processObservationEval as Mock).mockRejectedValue(llmError);
      (isLLMCompletionError as Mock).mockReturnValue(true);

      const job = createMockJob();

      // Should not throw - error is handled gracefully
      await expect(
        llmAsJudgeExecutionQueueProcessor(job),
      ).resolves.not.toThrow();
    });
  });

  describe("UnrecoverableError handling", () => {
    it("should set ERROR status with user-facing message for UnrecoverableError", async () => {
      const unrecoverableError = new UnrecoverableError(
        "Job configuration not found",
      );
      (processObservationEval as Mock).mockRejectedValue(unrecoverableError);
      (isUnrecoverableError as Mock).mockReturnValue(true);

      const job = createMockJob();
      await llmAsJudgeExecutionQueueProcessor(job);

      expect(prisma.jobExecution.update).toHaveBeenCalledWith({
        where: {
          id: jobExecutionId,
          projectId,
        },
        data: expect.objectContaining({
          status: JobExecutionStatus.ERROR,
          endTime: expect.any(Date),
          error: "Job configuration not found",
          executionTraceId: "test-trace-id",
        }),
      });
    });

    it("should not rethrow UnrecoverableError", async () => {
      const unrecoverableError = new UnrecoverableError("Config not found");
      (processObservationEval as Mock).mockRejectedValue(unrecoverableError);
      (isUnrecoverableError as Mock).mockReturnValue(true);

      const job = createMockJob();

      // Should not throw
      await expect(
        llmAsJudgeExecutionQueueProcessor(job),
      ).resolves.not.toThrow();
    });

    it("should not call traceException for UnrecoverableError", async () => {
      const unrecoverableError = new UnrecoverableError("Config not found");
      (processObservationEval as Mock).mockRejectedValue(unrecoverableError);
      (isUnrecoverableError as Mock).mockReturnValue(true);

      const job = createMockJob();
      await llmAsJudgeExecutionQueueProcessor(job);

      expect(traceException).not.toHaveBeenCalled();
    });
  });

  describe("unexpected errors (retryable by pg-boss)", () => {
    it("should set ERROR status with generic message for unexpected errors", async () => {
      const unexpectedError = new Error("Database connection failed");
      (processObservationEval as Mock).mockRejectedValue(unexpectedError);

      const job = createMockJob();

      // Should rethrow for queue retry
      await expect(llmAsJudgeExecutionQueueProcessor(job)).rejects.toThrow(
        "Database connection failed",
      );

      expect(prisma.jobExecution.update).toHaveBeenCalledWith({
        where: {
          id: jobExecutionId,
          projectId,
        },
        data: expect.objectContaining({
          status: JobExecutionStatus.ERROR,
          error: "An internal error occurred",
          executionTraceId: "test-trace-id",
        }),
      });
    });

    it("should call traceException for unexpected errors", async () => {
      const unexpectedError = new Error("Unexpected failure");
      (processObservationEval as Mock).mockRejectedValue(unexpectedError);

      const job = createMockJob();

      try {
        await llmAsJudgeExecutionQueueProcessor(job);
      } catch {
        // Expected to throw
      }

      expect(traceException).toHaveBeenCalledWith(unexpectedError);
    });

    it("should rethrow unexpected errors for queue retry", async () => {
      const unexpectedError = new Error("Network timeout");
      (processObservationEval as Mock).mockRejectedValue(unexpectedError);

      const job = createMockJob();

      await expect(llmAsJudgeExecutionQueueProcessor(job)).rejects.toThrow(
        "Network timeout",
      );
    });
  });

  describe("execution trace ID", () => {
    it("should generate deterministic trace ID from job execution ID", async () => {
      const error = new UnrecoverableError("Test error");
      (processObservationEval as Mock).mockRejectedValue(error);
      (isUnrecoverableError as Mock).mockReturnValue(true);

      const { createW3CTraceId } = await import("../../features/utils");

      const job = createMockJob();
      await llmAsJudgeExecutionQueueProcessor(job);

      expect(createW3CTraceId).toHaveBeenCalledWith(jobExecutionId);
    });
  });

  describe("retry baggage tracking", () => {
    it("should track retry attempt in span attributes", async () => {
      const mockSpan = { setAttribute: vi.fn() };
      const { getCurrentSpan } = await import("@langfuse/shared/src/server");
      (getCurrentSpan as Mock).mockReturnValue(mockSpan);
      (processObservationEval as Mock).mockResolvedValue(undefined);

      const job = createMockJob({
        retryBaggage: {
          attempt: 3,
          originalJobTimestamp: new Date(),
        },
      });
      await llmAsJudgeExecutionQueueProcessor(job);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "messaging.pgboss.job.input.retryBaggage.attempt",
        3,
      );
    });

    it("should default to 0 when retry baggage is missing", async () => {
      const mockSpan = { setAttribute: vi.fn() };
      const { getCurrentSpan } = await import("@langfuse/shared/src/server");
      (getCurrentSpan as Mock).mockReturnValue(mockSpan);
      (processObservationEval as Mock).mockResolvedValue(undefined);

      const job = createMockJob();
      delete (job.data as { retryBaggage?: unknown }).retryBaggage;

      await llmAsJudgeExecutionQueueProcessor(job);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "messaging.pgboss.job.input.retryBaggage.attempt",
        0,
      );
    });
  });

  describe("null span handling", () => {
    it("should handle null span gracefully", async () => {
      const { getCurrentSpan } = await import("@langfuse/shared/src/server");
      (getCurrentSpan as Mock).mockReturnValue(null);
      (processObservationEval as Mock).mockResolvedValue(undefined);

      const job = createMockJob();

      // Should not throw
      await expect(
        llmAsJudgeExecutionQueueProcessor(job),
      ).resolves.not.toThrow();
      expect(processObservationEval).toHaveBeenCalled();
    });
  });
});
