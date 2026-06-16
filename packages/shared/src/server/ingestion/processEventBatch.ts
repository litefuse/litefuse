import { z } from "zod/v4";

import {
  InvalidRequestError,
  LangfuseNotFoundError,
  UnauthorizedError,
} from "../../errors";
import { prisma } from "../../db";
import { AuthHeaderValidVerificationResultIngestion } from "../auth/types";
import { dorisClient } from "../doris/client";
import { getDorisEntityType } from "../doris/schemaUtils";
import {
  getCurrentSpan,
  recordDistribution,
  recordIncrement,
  traceException,
} from "../instrumentation";
import { logger } from "../logger";
import {
  eventTypes,
  createIngestionEventSchema,
  IngestionEventType,
  ObservationEvent,
  TraceEventType,
} from "./types";
import { IngestionService } from "./IngestionService";
import { RequestWriteBuffer } from "./RequestWriteBuffer";
import { isTraceIdInSample } from "./sampling";
import { tokenCount } from "../tokenisation/usage";

/**
 * Options for event batch processing.
 * @property source - Source of the events for metrics tracking (e.g., "otel", "api").
 * @property isLangfuseInternal - Whether the events are being ingested by Langfuse internally (e.g. traces created for prompt experiments).
 */
type ProcessEventBatchOptions = {
  source?: "api" | "otel";
  isLangfuseInternal?: boolean;
};

/**
 * Web-side direct ingestion processor.
 *
 * Pipeline (single HTTP request):
 *   1. Validate / authorize each event in the batch.
 *   2. Sort and group events by `eventBodyId` so updates to the same
 *      entity merge in-batch.
 *   3. Apply the per-project sampling decision.
 *   4. For each entity group, call IngestionService.mergeAndWrite with a
 *      RequestWriteBuffer — IngestionService keeps its full pre-read +
 *      cross-batch ARRAY-column merge logic; the buffer just collects
 *      records keyed by destination table.
 *   5. RequestWriteBuffer.flushAll issues one Stream Load per touched
 *      table in parallel with `group_commit: sync_mode`, so the HTTP
 *      handler ack-s the SDK only once Doris has the rows.
 *
 * Failure handling: any error (validation, Doris unavailable, group
 * commit timeout, …) propagates up to the API route, which surfaces it
 * as 5xx. SDKs already retry on 5xx; there is no longer an internal
 * buffer that could mask a write failure.
 *
 * Note: this is the langfuse private-protocol entry. OTel ingestion has
 * its own processor that re-uses the same IngestionService +
 * RequestWriteBuffer pair (no S3 / BullMQ involved there either).
 */
export const processEventBatch = async (
  input: unknown[],
  authCheck: AuthHeaderValidVerificationResultIngestion,
  options: ProcessEventBatchOptions = {},
): Promise<{
  successes: { id: string; status: number }[];
  errors: {
    id: string;
    status: number;
    message?: string;
    error?: string;
  }[];
}> => {
  if (input.length === 0) {
    return { successes: [], errors: [] };
  }
  const { source = "api", isLangfuseInternal = false } = options;

  const currentSpan = getCurrentSpan();
  recordIncrement("langfuse.ingestion.event", input.length, { source });
  recordDistribution("langfuse.ingestion.event_distribution", input.length, {
    source,
  });

  currentSpan?.setAttribute("langfuse.ingestion.batch_size", input.length);
  currentSpan?.setAttribute(
    "langfuse.project.id",
    authCheck.scope.projectId ?? "",
  );
  if (authCheck.scope.orgId)
    currentSpan?.setAttribute("langfuse.org.id", authCheck.scope.orgId);
  if (authCheck.scope.plan)
    currentSpan?.setAttribute("langfuse.org.plan", authCheck.scope.plan);

  /**************
   * VALIDATION *
   **************/
  if (!authCheck.scope.projectId) {
    throw new UnauthorizedError("Missing project ID");
  }

  const validationErrors: { id: string; error: unknown }[] = [];
  const authenticationErrors: { id: string; error: unknown }[] = [];

  const ingestionSchema = createIngestionEventSchema(isLangfuseInternal);
  const batch: z.infer<typeof ingestionSchema>[] = input
    .flatMap((event) => {
      const parsed = ingestionSchema.safeParse(event);
      if (!parsed.success) {
        validationErrors.push({
          id:
            typeof event === "object" && event && "id" in event
              ? typeof event.id === "string"
                ? event.id
                : "unknown"
              : "unknown",
          error: new InvalidRequestError(parsed.error.message),
        });
        return [];
      }
      if (!isAuthorized(parsed.data, authCheck)) {
        authenticationErrors.push({
          id: parsed.data.id,
          error: new UnauthorizedError("Access Scope Denied"),
        });
        return [];
      }
      return [parsed.data];
    })
    .flatMap((event) => {
      if (event.type === eventTypes.SDK_LOG) {
        // Log SDK_LOG events, but remove them from further processing
        logger.info("SDK Log Event", { event });
        return [];
      }
      return [event];
    });

  const sortedBatch = sortBatch(batch);

  const nativeTraceObservationEvents = sortedBatch.filter((event) => {
    const entityType = getDorisEntityType(event.type);
    return entityType === "trace" || entityType === "observation";
  });

  const otherEvents = sortedBatch.filter((event) => {
    const entityType = getDorisEntityType(event.type);
    return entityType !== "trace" && entityType !== "observation";
  });

  // Group non-trace/observation events by eventBodyId so updates to the
  // same score/dataset run item merge in-batch instead of issuing one
  // Stream Load per event.
  const otherEventsByEventBodyId = otherEvents.reduce(
    (
      acc: Record<
        string,
        {
          data: IngestionEventType[];
          eventBodyId: string;
          type: (typeof eventTypes)[keyof typeof eventTypes];
        }
      >,
      event,
    ) => {
      if (!event.body?.id) {
        return acc;
      }
      const key = `${getDorisEntityType(event.type)}-${event.body.id}`;
      if (!acc[key]) {
        acc[key] = {
          data: [],
          type: event.type,
          eventBodyId: event.body.id,
        };
      }
      acc[key].data.push(event);
      return acc;
    },
    {},
  );

  const nativeEventsByTraceId = nativeTraceObservationEvents.reduce(
    (acc: Record<string, Array<TraceEventType | ObservationEvent>>, event) => {
      const traceGroupId = getDirectNativeTraceGroupId(event);
      if (!traceGroupId) return acc;
      if (!acc[traceGroupId]) acc[traceGroupId] = [];
      acc[traceGroupId].push(event as TraceEventType | ObservationEvent);
      return acc;
    },
    {},
  );

  /*****************
   * DIRECT WRITE  *
   *****************/
  // One RequestWriteBuffer per HTTP request. IngestionService writes
  // through the buffer; flushAll() at the end issues one Stream Load
  // per touched table with `group_commit: sync_mode` so the SDK ack
  // means "data is durable in Doris".
  //
  // Redis is intentionally NOT passed: the ingestion hot path runs
  // without it. PromptService falls back to direct Postgres reads,
  // and the eval-config cache short-circuit (hasNoEvalConfigsCache)
  // is skipped — we always enqueue TraceUpsert pg-boss jobs and let
  // the worker filter empty-config projects out. Trade: a few extra
  // pg-boss sends per request vs zero Redis coupling on this path.
  //
  // Tokenization is wired inline. tiktoken's sibling WASM loads via
  // Node's native runtime require because `serverExternalPackages`
  // includes it (see web/next.config.mjs). This path only triggers for
  // generations missing SDK-supplied usage — case 1 (SDK reports
  // usage) short-circuits to pure arithmetic in getGenerationUsage and
  // never enters the tokenizer.
  const writer = new RequestWriteBuffer(dorisClient());
  const ingestionService = new IngestionService(
    prisma,
    writer,
    dorisClient(),
    /* tokenCountAsync */ null,
    /* tokenCount */ tokenCount,
  );

  const createdAtTimestamp = new Date();

  await Promise.all([
    ...Object.keys(nativeEventsByTraceId).map(async (traceId) => {
      const eventData = nativeEventsByTraceId[traceId]!;

      const { isSampled, isSamplingConfigured } = isTraceIdInSample({
        projectId: authCheck.scope.projectId,
        event: eventData[0] as IngestionEventType,
      });

      if (!isSampled) {
        recordIncrement("litefuse.ingestion.sampling", eventData.length, {
          projectId: authCheck.scope.projectId ?? "<not set>",
          sampling_decision: "out",
        });
        return;
      }

      if (isSamplingConfigured) {
        recordIncrement("langfuse.ingestion.sampling", eventData.length, {
          projectId: authCheck.scope.projectId ?? "<not set>",
          sampling_decision: "in",
        });
      }

      await ingestionService.directWriteTraceObservationEvents({
        projectId: authCheck.scope.projectId!,
        createdAtTimestamp,
        events: eventData as Array<TraceEventType | ObservationEvent>,
        source,
      });
    }),
    ...Object.keys(otherEventsByEventBodyId).map(async (id) => {
      const eventData = otherEventsByEventBodyId[id];

      const { isSampled, isSamplingConfigured } = isTraceIdInSample({
        projectId: authCheck.scope.projectId,
        event: eventData.data[0],
      });

      if (!isSampled) {
        recordIncrement("langfuse.ingestion.sampling", eventData.data.length, {
          projectId: authCheck.scope.projectId ?? "<not set>",
          sampling_decision: "out",
        });
        return;
      }

      if (isSamplingConfigured) {
        recordIncrement("langfuse.ingestion.sampling", eventData.data.length, {
          projectId: authCheck.scope.projectId ?? "<not set>",
          sampling_decision: "in",
        });
      }

      await ingestionService.mergeAndWrite(
        getDorisEntityType(eventData.type),
        authCheck.scope.projectId!,
        eventData.eventBodyId,
        createdAtTimestamp,
        eventData.data,
      );
    }),
  ]);

  await writer.flushAll();

  return aggregateBatchResult(
    [...validationErrors, ...authenticationErrors],
    sortedBatch.map((event) => ({ id: event.id, result: event })),
    authCheck.scope.projectId,
  );
};

const isAuthorized = (
  event: IngestionEventType,
  authScope: AuthHeaderValidVerificationResultIngestion,
): boolean => {
  if (event.type === eventTypes.SDK_LOG) {
    return true;
  }

  if (event.type === eventTypes.SCORE_CREATE) {
    return (
      authScope.scope.accessLevel === "scores" ||
      authScope.scope.accessLevel === "project"
    );
  }

  return authScope.scope.accessLevel === "project";
};

/**
 * Sorts a batch of ingestion events. Orders by: updating events last, sorted by timestamp asc.
 */
const sortBatch = (batch: IngestionEventType[]) => {
  const updateEvents: (typeof eventTypes)[keyof typeof eventTypes][] = [
    eventTypes.GENERATION_UPDATE,
    eventTypes.SPAN_UPDATE,
    eventTypes.OBSERVATION_UPDATE, // legacy event type
  ];
  const updates = batch
    .filter((event) => updateEvents.includes(event.type))
    .sort((a, b) => {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  const others = batch
    .filter((event) => !updateEvents.includes(event.type))
    .sort((a, b) => {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

  // Return the array with non-update events first, followed by update events
  return [...others, ...updates];
};

const getDirectNativeTraceGroupId = (event: IngestionEventType) => {
  if (event.type === eventTypes.TRACE_CREATE) {
    return event.body.id;
  }

  if ("traceId" in event.body && event.body.traceId) {
    return event.body.traceId;
  }

  return event.body.id;
};

export const aggregateBatchResult = (
  errors: Array<{ id: string; error: unknown }>,
  results: Array<{ id: string; result: unknown }>,
  projectId?: string,
) => {
  const returnedErrors: {
    id: string;
    status: number;
    message?: string;
    error?: string;
  }[] = [];

  const successes: {
    id: string;
    status: number;
  }[] = [];

  errors.forEach((error) => {
    if (error.error instanceof InvalidRequestError) {
      returnedErrors.push({
        id: error.id,
        status: 400,
        message: "Invalid request data",
        error: error.error.message,
      });
    } else if (error.error instanceof UnauthorizedError) {
      returnedErrors.push({
        id: error.id,
        status: 401,
        message: "Authentication error",
        error: error.error.message,
      });
    } else if (error.error instanceof LangfuseNotFoundError) {
      returnedErrors.push({
        id: error.id,
        status: 404,
        message: "Resource not found",
        error: error.error.message,
      });
    } else {
      returnedErrors.push({
        id: error.id,
        status: 500,
        error: "Internal Server Error",
      });
    }
  });

  if (returnedErrors.length > 0) {
    traceException(errors);
    logger.error("Error processing events", {
      errors: returnedErrors,
      "langfuse.project.id": projectId,
    });
  }

  results.forEach((result) => {
    successes.push({
      id: result.id,
      status: 201,
    });
  });

  return { successes, errors: returnedErrors };
};
