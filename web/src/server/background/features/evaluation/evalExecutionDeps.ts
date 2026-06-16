import { type JobExecutionStatus } from "@prisma/client";
import { prisma } from "@langfuse/shared/src/db";
import {
  DefaultEvalModelService,
  fetchLLMCompletion,
  type LLMAdapter,
  type ScoreEventType,
  processEventBatch,
  type AuthHeaderValidVerificationResultIngestion,
} from "@langfuse/shared/src/server";
import {
  type buildEvalScoreSchema,
  type buildEvalMessages,
} from "./evalExecutionUtils";

/**
 * Result of fetching model configuration.
 */
export type ModelConfigResult =
  | {
      valid: true;
      config: {
        provider: string;
        model: string;
        apiKey: {
          adapter: string;
          [key: string]: unknown;
        };
        adapter: LLMAdapter;
        modelParams: Record<string, unknown>;
      };
    }
  | {
      valid: false;
      error: string;
    };

/**
 * Parameters for calling the LLM.
 */
export interface LLMCallParams {
  messages: ReturnType<typeof buildEvalMessages>;
  modelConfig: Extract<ModelConfigResult, { valid: true }>["config"];
  structuredOutputSchema: ReturnType<typeof buildEvalScoreSchema>;
  traceSinkParams: {
    targetProjectId: string;
    traceId: string;
    traceName: string;
    environment: string;
    metadata: Record<string, unknown>;
  };
}

/**
 * Update data for job execution status.
 */
export interface UpdateJobExecutionData {
  status: JobExecutionStatus;
  endTime?: Date;
  jobOutputScoreId?: string;
  executionTraceId?: string;
}

/**
 * Parameters for persisting an eval-generated score.
 *
 * Previously the eval pipeline did "upload score JSON to S3" then
 * "enqueue an IngestionQueue job by S3 key"; both have been collapsed
 * to a single direct-write through processEventBatch (the same path
 * the public ingestion API uses).
 */
export interface EnqueueScoreIngestionParams {
  projectId: string;
  scoreId: string;
  event: ScoreEventType;
}

/**
 * Parameters for updating a job execution.
 */
export interface UpdateJobExecutionParams {
  id: string;
  projectId: string;
  data: UpdateJobExecutionData;
}

/**
 * Parameters for fetching model configuration.
 */
export interface FetchModelConfigParams {
  projectId: string;
  provider?: string;
  model?: string;
  modelParams?: Record<string, unknown> | null;
}

/**
 * Dependency interface for eval execution.
 * This allows for easy mocking in tests while providing
 * a clear contract for all external dependencies.
 *
 * Note: Database fetching (job, config, template) is handled by callers,
 * not by the executor. This interface only covers operations needed
 * during LLM execution and score persistence.
 */
export interface EvalExecutionDeps {
  // Database operations (for status updates only)
  updateJobExecution: (params: UpdateJobExecutionParams) => Promise<void>;

  // Score ingestion (direct-write through processEventBatch)
  enqueueScoreIngestion: (params: EnqueueScoreIngestionParams) => Promise<void>;

  // LLM operations
  callLLM: (params: LLMCallParams) => Promise<unknown>;
  fetchModelConfig: (
    params: FetchModelConfigParams,
  ) => Promise<ModelConfigResult>;
}

/**
 * Creates the production implementation of eval execution dependencies.
 * This is the default implementation used in production code.
 */
export function createProductionEvalExecutionDeps(): EvalExecutionDeps {
  return {
    updateJobExecution: async ({ id, projectId, data }) => {
      await prisma.jobExecution.update({
        where: { id, projectId },
        data,
      });
    },

    enqueueScoreIngestion: async (params) => {
      // Direct-write the score event through processEventBatch (the same
      // path the public ingestion API uses). The previous BullMQ
      // IngestionQueue enqueue + worker S3 download is gone.
      await processEventBatch(
        [params.event as unknown as Record<string, unknown>],
        {
          validKey: true,
          scope: {
            projectId: params.projectId,
            accessLevel: "project",
          },
        } as AuthHeaderValidVerificationResultIngestion,
      );
    },

    callLLM: async (params) => {
      // Type assertion needed because the deps interface uses a simplified apiKey type for testability
      // while the actual fetchLLMCompletion requires a full LlmApiKey type
      const llmConnection = params.modelConfig.apiKey as unknown as Parameters<
        typeof fetchLLMCompletion
      >[0]["llmConnection"];

      const adapter = params.modelConfig.apiKey
        .adapter as unknown as Parameters<
        typeof fetchLLMCompletion
      >[0]["modelParams"]["adapter"];

      return fetchLLMCompletion({
        streaming: false,
        llmConnection,
        messages: params.messages,
        modelParams: {
          provider: params.modelConfig.provider,
          model: params.modelConfig.model,
          adapter,
          ...params.modelConfig.modelParams,
        },
        structuredOutputSchema: params.structuredOutputSchema,
        maxRetries: 1,
        traceSinkParams: {
          targetProjectId: params.traceSinkParams.targetProjectId,
          traceId: params.traceSinkParams.traceId,
          traceName: params.traceSinkParams.traceName,
          environment: params.traceSinkParams.environment,
          metadata: params.traceSinkParams.metadata,
        },
      });
    },

    fetchModelConfig: async ({ projectId, provider, model, modelParams }) => {
      const result = await DefaultEvalModelService.fetchValidModelConfig(
        projectId,
        provider,
        model,
        modelParams,
      );

      // Cast to our simplified ModelConfigResult type for the interface
      return result as ModelConfigResult;
    },
  };
}

/**
 * Creates a mock implementation of eval execution dependencies for testing.
 * All functions are no-ops or return null by default.
 * Override specific functions as needed in tests.
 */
export function createMockEvalExecutionDeps(
  overrides?: Partial<EvalExecutionDeps>,
): EvalExecutionDeps {
  const defaultMock: EvalExecutionDeps = {
    updateJobExecution: async () => {},
    enqueueScoreIngestion: async () => {},
    callLLM: async () => ({ score: 0.5, reasoning: "Mock response" }),
    fetchModelConfig: async () => ({
      valid: false,
      error: "Mock - no config",
    }),
  };

  return { ...defaultMock, ...overrides };
}
