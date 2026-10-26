// ── LITEFUSE ADDITION (evaluators v2: decision-model execution trace) ───────
// The LLM judge runs through `fetchLLMCompletion`, whose `traceSinkParams` write
// an internal execution trace (environment `langfuse-llm-as-a-judge`). The
// decision model calls TypeSafe directly, so without this module a "Jev" run
// leaves no trace to inspect.
//
// Upstream builds the same record in `buildDecisionModelTraceInput` and writes it
// with `writeInternalTraceViaOtelIngestion` (its `internalTraceEvents.ts` +
// `internalTraceOtelWriter.ts`, ~830 lines combined). Litefuse already has the
// two primitives that matter — `internalTraceEventsToResourceSpans` (classic
// internal events → OTLP resource spans) and `OtelIngestionProcessor.
// publishToOtelIngestionQueue` — so this module builds the two events inline
// instead of porting that pair of files. Same pipeline, same attributes.
//
// These traces are also the ONLY per-evaluator execution ledger we have: the
// "Last 5 runs" column reads `metadata['evaluator_id']` back out of them
// (`packages/shared/src/server/repositories/evalCostCompat.ts`,
// `getRecentEvaluatorExecutionTraces`). So the metadata keys below are load
// bearing, not decoration, and a FAILED execution has to leave a trace too —
// with `level=ERROR` and a readable `statusMessage` — or it would be invisible
// to that reader (upstream gets the same effect from its AI-SDK telemetry
// capture, which marks the root span as failed).
//
// Best-effort by design: a failed trace must never fail the evaluation.
// ─────────────────────────────────────────────────────────────────────────────

import {
  LangfuseInternalTraceEnvironment,
  OtelIngestionProcessor,
  internalTraceEventsToResourceSpans,
  logger,
  traceException,
} from "@langfuse/shared/src/server";
import {
  type DecisionModelEvaluation,
  type DecisionModelRequest,
} from "@langfuse/shared/src/server";

/** The classic internal-tracing event shape the converter consumes. */
export type InternalTraceEvent = {
  type: string;
  body: Record<string, unknown>;
};

/** Longest `statusMessage` we write for a failed execution. */
const MAX_STATUS_MESSAGE_LENGTH = 1_000;

/**
 * Builds the internal-tracing events for one decision-model call: a trace event
 * plus one GENERATION observation carrying the request as input and the answers
 * as output. Pure, so tests can assert the record without a queue.
 */
export function buildDecisionModelTraceEvents(params: {
  projectId: string;
  executionTraceId: string;
  traceName: string;
  traceStartTime: Date;
  traceEndTime: Date;
  request: DecisionModelRequest;
  evaluation: DecisionModelEvaluation;
  metadata: Record<string, unknown>;
}): InternalTraceEvent[] {
  const { evaluation } = params;
  const usage = evaluation.usage;

  return [
    {
      type: "trace-create",
      body: {
        id: params.executionTraceId,
        timestamp: params.traceStartTime.toISOString(),
        name: params.traceName,
        metadata: params.metadata,
      },
    },
    {
      type: "generation-create",
      body: {
        id: params.executionTraceId,
        traceId: params.executionTraceId,
        name: params.traceName,
        startTime: params.traceStartTime.toISOString(),
        endTime: params.traceEndTime.toISOString(),
        model: evaluation.model,
        input: JSON.stringify(params.request),
        output: JSON.stringify(evaluation.answers),
        metadata: params.metadata,
        ...(usage
          ? {
              usageDetails: {
                ...(usage.inputTokens !== null
                  ? { input: usage.inputTokens }
                  : {}),
                ...(usage.outputTokens !== null
                  ? { output: usage.outputTokens }
                  : {}),
              },
            }
          : {}),
      },
    },
  ];
}

/**
 * Turns a thrown value into the readable `statusMessage` a failed execution
 * trace carries. The evaluation itself is already reported through
 * `job_executions.error`; this is the same reason, attached to the trace so the
 * evaluator's run history can show WHY a marker is red.
 */
export function describeExecutionFailure(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || error.name
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();

  const message = raw?.trim() ? raw.trim() : "Unknown evaluation error";
  return message.length > MAX_STATUS_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_STATUS_MESSAGE_LENGTH - 1)}…`
    : message;
}

/**
 * Builds the internal-tracing events for a FAILED execution: a trace event plus
 * one root SPAN carrying `level=ERROR` and the failure reason.
 *
 * The shape mirrors the LLM judge's failed executions, where upstream's AI-SDK
 * telemetry capture marks the root span as errored; a decision-model run that
 * throws before or during the model call would otherwise leave nothing behind.
 * Pure, so tests can assert the record without a queue.
 */
export function buildExecutionFailureTraceEvents(params: {
  executionTraceId: string;
  traceName: string;
  traceStartTime: Date;
  traceEndTime: Date;
  metadata: Record<string, unknown>;
  statusMessage: string;
}): InternalTraceEvent[] {
  return [
    {
      type: "trace-create",
      body: {
        id: params.executionTraceId,
        timestamp: params.traceStartTime.toISOString(),
        name: params.traceName,
        metadata: params.metadata,
      },
    },
    {
      type: "span-create",
      body: {
        id: params.executionTraceId,
        traceId: params.executionTraceId,
        name: params.traceName,
        startTime: params.traceStartTime.toISOString(),
        endTime: params.traceEndTime.toISOString(),
        level: "ERROR",
        statusMessage: params.statusMessage,
        metadata: params.metadata,
      },
    },
  ];
}

/**
 * Publishes already-built internal events as an internal trace.
 *
 * The environment is the reserved judge environment, exactly like upstream: it is
 * what keeps an eval from being scheduled on its own execution telemetry
 * (`isEvalTargetEnvironmentAllowed` blocks it).
 */
async function publishEvaluatorExecutionTraceEvents(params: {
  projectId: string;
  executionTraceId: string;
  events: InternalTraceEvent[];
}): Promise<void> {
  const resourceSpans = internalTraceEventsToResourceSpans(params.events, {
    environment: LangfuseInternalTraceEnvironment.LLMJudge,
  });

  if (!resourceSpans[0]?.scopeSpans?.[0]?.spans?.length) {
    logger.debug(
      `No internal trace spans produced for ${params.executionTraceId}`,
    );
    return;
  }

  const processor = new OtelIngestionProcessor({
    projectId: params.projectId,
  });
  await processor.publishToOtelIngestionQueue(resourceSpans);
}

/**
 * Publishes the decision-model execution as an internal trace.
 */
export async function writeDecisionModelExecutionTrace(params: {
  projectId: string;
  executionTraceId: string;
  traceName: string;
  traceStartTime: Date;
  request: DecisionModelRequest;
  evaluation: DecisionModelEvaluation;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    const events = buildDecisionModelTraceEvents({
      ...params,
      traceEndTime: new Date(),
    });

    await publishEvaluatorExecutionTraceEvents({
      projectId: params.projectId,
      executionTraceId: params.executionTraceId,
      events,
    });
  } catch (error) {
    // Same contract as upstream: tracing is observability, not the result.
    logger.error("Failed to write decision-model execution trace", {
      executionTraceId: params.executionTraceId,
      error,
    });
    traceException(error);
  }
}

/**
 * Records a FAILED evaluator execution (LLM judge or decision model) as an
 * internal trace at `level=ERROR`, carrying the same execution metadata as the
 * successful path plus the failure reason.
 *
 * Called from both executors' catch blocks, so every execution that reaches an
 * executor leaves exactly one trace: either the success record or this one. The
 * trace id is the deterministic id of the job execution
 * (`createW3CTraceId(jobExecutionId)`), which is the same id the queue processor
 * stamps on the failed `job_executions` row.
 *
 * Best-effort, like the success writer: failing to trace must not mask the
 * original error.
 */
export async function writeEvaluatorExecutionFailureTrace(params: {
  projectId: string;
  executionTraceId: string;
  traceName: string;
  /** When the execution started; the trace keeps that as its start time. */
  traceStartTime: Date;
  metadata: Record<string, unknown>;
  error: unknown;
}): Promise<void> {
  try {
    const events = buildExecutionFailureTraceEvents({
      executionTraceId: params.executionTraceId,
      traceName: params.traceName,
      traceStartTime: params.traceStartTime,
      traceEndTime: new Date(),
      metadata: params.metadata,
      statusMessage: describeExecutionFailure(params.error),
    });

    await publishEvaluatorExecutionTraceEvents({
      projectId: params.projectId,
      executionTraceId: params.executionTraceId,
      events,
    });
  } catch (traceError) {
    logger.error("Failed to write evaluator failure trace", {
      executionTraceId: params.executionTraceId,
      error: traceError,
    });
    traceException(traceError);
  }
}
