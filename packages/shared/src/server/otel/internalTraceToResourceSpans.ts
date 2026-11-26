import { LangfuseOtelSpanAttributes } from "./attributes";
import type { ResourceSpan } from "./OtelIngestionProcessor";

/**
 * Converts the classic Langfuse ingestion events emitted by the internal
 * LangChain tracing handler (CallbackHandler._exportLocalEvents) into OTLP
 * ResourceSpans, so internal-tracing (eval-judge / experiment / NL-filters LLM
 * calls) flows through the SAME OTel → spans pipeline as all other traces.
 *
 * Rationale: legacy `traces`/`observation_source` tables no longer exist (split
 * model only). The previous path (`processEventBatch` → IngestionService
 * mergeAndWrite → those tables) is dead. Everything must land in spans_<pid> via
 * the OTel lane. publishToOtelIngestionQueue is shared (used by the web OTel
 * endpoint too), so this works from both web and worker.
 *
 * Note: parseId (OtelIngestionProcessor) returns string ids verbatim
 * (`typeof data === "string" ? data : hex`), and the reader does
 * `span.traceId?.data ?? span.traceId` — so passing the classic string ids
 * directly round-trips them unchanged as trace_id / span_id.
 */

type InternalEvent = { type: string; body: Record<string, any> };

const isoToNano = (iso?: string | null): string | undefined =>
  iso ? (BigInt(new Date(iso).getTime()) * 1_000_000n).toString() : undefined;

const strAttr = (key: string, v: unknown) =>
  v === undefined || v === null
    ? null
    : {
        key,
        value: {
          stringValue: typeof v === "string" ? v : JSON.stringify(v),
        },
      };

const boolAttr = (key: string, v: unknown) =>
  v === undefined || v === null
    ? null
    : { key, value: { boolValue: Boolean(v) } };

const observationType = (type: string): string =>
  type.startsWith("generation")
    ? "generation"
    : type.startsWith("event")
      ? "event"
      : "span";

export function internalTraceEventsToResourceSpans(
  events: InternalEvent[],
  opts: { environment?: string } = {},
): ResourceSpan[] {
  const traceEvent = events.find((e) => e.type.startsWith("trace"));
  const obsEvents = events.filter(
    (e) =>
      e.type.startsWith("generation") ||
      e.type.startsWith("span") ||
      e.type.startsWith("event"),
  );
  if (obsEvents.length === 0) return [];

  // Merge -create/-update per observation id (LangChain emits create at start,
  // update at end with output/usage/endTime). Later non-null fields win.
  const merged = new Map<string, InternalEvent>();
  for (const e of obsEvents) {
    const id = e.body?.id;
    if (!id) continue;
    const prev = merged.get(id);
    const cleanBody = Object.fromEntries(
      Object.entries(e.body).filter(([, v]) => v !== undefined && v !== null),
    );
    merged.set(id, {
      type: e.type.includes("generation")
        ? "generation-create"
        : (prev?.type ?? e.type),
      body: { ...(prev?.body ?? {}), ...cleanBody },
    });
  }

  const spans = [...merged.values()]
    // Guard: parseId does Buffer.from(id) for non-strings; a missing traceId/id
    // would throw downstream. Internal events always carry both, but skip
    // defensively rather than fail the whole group file.
    .filter(({ body }) => body.id && body.traceId)
    .map(({ type, body }) => {
      const isRoot = !body.parentObservationId;
      const attributes: Array<{ key: string; value: any }> = [];
      const push = (a: { key: string; value: any } | null) => {
        if (a) attributes.push(a);
      };

      push(
        strAttr(
          LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
          observationType(type),
        ),
      );
      push(strAttr(LangfuseOtelSpanAttributes.OBSERVATION_INPUT, body.input));
      push(strAttr(LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT, body.output));
      push(strAttr(LangfuseOtelSpanAttributes.OBSERVATION_MODEL, body.model));
      push(
        strAttr(
          LangfuseOtelSpanAttributes.OBSERVATION_MODEL_PARAMETERS,
          body.modelParameters,
        ),
      );
      push(
        strAttr(
          LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS,
          body.usageDetails ?? body.usage,
        ),
      );
      push(strAttr(LangfuseOtelSpanAttributes.OBSERVATION_LEVEL, body.level));
      push(
        strAttr(
          LangfuseOtelSpanAttributes.OBSERVATION_STATUS_MESSAGE,
          body.statusMessage,
        ),
      );
      push(
        strAttr(
          LangfuseOtelSpanAttributes.OBSERVATION_COMPLETION_START_TIME,
          body.completionStartTime,
        ),
      );
      push(
        strAttr(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, body.metadata),
      );
      push(
        strAttr(
          LangfuseOtelSpanAttributes.OBSERVATION_PROMPT_NAME,
          body.promptName,
        ),
      );
      push(
        strAttr(
          LangfuseOtelSpanAttributes.OBSERVATION_PROMPT_VERSION,
          body.promptVersion,
        ),
      );
      if (opts.environment)
        push(strAttr(LangfuseOtelSpanAttributes.ENVIRONMENT, opts.environment));

      if (isRoot) {
        push(boolAttr(LangfuseOtelSpanAttributes.AS_ROOT, true));
        const tb = traceEvent?.body ?? {};
        push(
          strAttr(LangfuseOtelSpanAttributes.TRACE_NAME, tb.name ?? body.name),
        );
        push(strAttr(LangfuseOtelSpanAttributes.TRACE_USER_ID, tb.userId));
        push(
          strAttr(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, tb.sessionId),
        );
        push(strAttr(LangfuseOtelSpanAttributes.TRACE_TAGS, tb.tags));
        push(strAttr(LangfuseOtelSpanAttributes.TRACE_METADATA, tb.metadata));
        push(boolAttr(LangfuseOtelSpanAttributes.TRACE_PUBLIC, tb.public));
        push(strAttr(LangfuseOtelSpanAttributes.TRACE_INPUT, tb.input));
        push(strAttr(LangfuseOtelSpanAttributes.TRACE_OUTPUT, tb.output));
      }

      return {
        // parseId returns string ids verbatim; the reader does
        // `traceId?.data ?? traceId`, so a bare string is safe.
        traceId: body.traceId as any,
        spanId: body.id as any,
        ...(body.parentObservationId
          ? { parentSpanId: body.parentObservationId as any }
          : {}),
        name: body.name ?? "internal",
        kind: 1,
        startTimeUnixNano: isoToNano(body.startTime),
        endTimeUnixNano: isoToNano(body.endTime),
        attributes,
      };
    });

  return [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          scope: { name: "langfuse-internal-tracing", version: "1.0.0" },
          spans,
        },
      ],
    },
  ];
}
