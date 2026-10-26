// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Task: fetch the single observation an evaluation runs against.
//
// Upstream reads ClickHouse and has two paths behind a migration flag: the legacy
// `observations` table, or the new events stream. Litefuse has neither — trace
// roots and observation spans live together in the per-project split table
// `spans_<projectId>` (selected via `tableFor`), there is no physical
// `observations` table, and we have no ingestion-migration switch.
//
// So this is the third path, written against our own read path
// (`getObservationByIdFromEventsTable`, which routes to `spans_<projectId>`), and
// mapped into the shared `observationForEvalSchema` — the same mapping upstream's
// legacy path applies to its domain object. Copying that mapping rather than
// inventing one keeps the eval-facing shape identical.
//
// This is one of the two storage-boundary functions for the evaluator system; the
// other is the score write path.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DEFAULT_TRACE_ENVIRONMENT,
  getObservationByIdFromEventsTable,
} from "@langfuse/shared/src/server";
import {
  LangfuseNotFoundError,
  observationForEvalSchema,
  type ObservationForEval,
} from "@langfuse/shared";

export async function getObservationForEvalById(params: {
  projectId: string;
  id: string;
  traceId: string;
  startTime: Date;
  /** Accepted for call-site compatibility with upstream; our read path has no
   *  second backing table to switch to. */
  shouldReadFromObservationsTable?: boolean;
}): Promise<ObservationForEval> {
  const observation = await getObservationByIdFromEventsTable({
    projectId: params.projectId,
    id: params.id,
    traceId: params.traceId,
    startTime: params.startTime,
    fetchWithInputOutput: true,
  }).catch((error) => {
    if (error instanceof LangfuseNotFoundError) {
      throw new LangfuseNotFoundError("Observation not found");
    }
    throw error;
  });

  if (!observation) {
    throw new LangfuseNotFoundError("Observation not found");
  }

  return observationForEvalSchema.parse({
    span_id: observation.id,
    trace_id: observation.traceId ?? params.traceId,
    project_id: params.projectId,
    parent_span_id: observation.parentObservationId,
    type: observation.type,
    name: observation.name ?? "",
    environment: observation.environment ?? DEFAULT_TRACE_ENVIRONMENT,
    version: observation.version,
    level: observation.level,
    status_message: observation.statusMessage,
    // Trace-level fields live on our separate `traces_scalar_<projectId>` row and
    // are not part of this read. Upstream's legacy path leaves them empty too.
    trace_name: null,
    user_id: null,
    session_id: null,
    tags: [],
    release: null,
    provided_model_name: observation.model,
    model_parameters: observation.modelParameters,
    prompt_id: observation.promptId,
    prompt_name: observation.promptName,
    prompt_version: observation.promptVersion,
    // Our Observation domain object has no `providedUsageDetails` field; usage is
    // carried once, in `usageDetails`.
    provided_usage_details: observation.usageDetails ?? {},
    provided_cost_details: observation.providedCostDetails ?? {},
    usage_details: observation.usageDetails ?? {},
    cost_details: observation.costDetails ?? {},
    tool_definitions: observation.toolDefinitions ?? {},
    tool_calls: observation.toolCalls ?? [],
    tool_call_names: observation.toolCallNames ?? [],
    // Derived (no storage counterpart): upstream's numeric `toolCalls` filter is
    // the tool-call count. Same derivation as the display layer's
    // `length(o.tool_calls)` and as the live/batch paths; `tool_call_names` is
    // authoritative for count and order.
    tool_call_count: observation.toolCallNames?.length ?? 0,
    // Root-span flag: our spans read exposes the `parent_span_id` convention
    // (`''`/null for a trace root), which is exactly how ingestion derives the
    // stored `is_root`. The eval filter registry compares the normalised boolean
    // (`observationForEvalSchema.is_root`) against the rule's `isRootObservation`
    // filter.
    is_root: !observation.parentObservationId,
    experiment_id: null,
    experiment_name: null,
    experiment_description: null,
    experiment_dataset_id: null,
    experiment_item_id: null,
    experiment_item_expected_output: null,
    // Upstream's boolean `isExperimentItemRootSpan` filter is derived by
    // `mapEventEvalFilterColumnIdToField` from
    // "span_id === experiment_item_root_span_id", so this projection must carry
    // the real stored id (the read path above was extended to return it) rather
    // than a hardcoded null. Rows of a non-experiment observation store
    // NULL/'' and derive to `false`, like upstream's boolean.
    experiment_item_root_span_id:
      observation.experiment_item_root_span_id ?? null,
    input: observation.input,
    output: observation.output,
    metadata: observation.metadata,
  });
}
