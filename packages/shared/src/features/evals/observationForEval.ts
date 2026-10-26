import { z } from "zod/v4";
import { DEFAULT_TRACE_ENVIRONMENT } from "../../server/ingestion/types";
import { type EventRecordBaseType } from "../../server/repositories/definitions";
import { ObservationLevel, ObservationType } from "../../domain";
import { SingleValueOption } from "../../tableDefinitions";
import { ColumnDefinition } from "../../tableDefinitions";
import { formatColumnOptions } from "../../tableDefinitions/typeHelpers";
// Added with the tool-call cluster below (copied from upstream). Upstream's
// version of this file already imports it.
import { parseJsonIfString } from "../../utils/json";

const flexibleUsageCostSchema = z.record(
  z.string(),
  z.coerce.number().nullable(),
);

export const observationForEvalSchema = z.object({
  // Identifiers
  span_id: z.string(),
  trace_id: z.string(),
  project_id: z.string(),
  parent_span_id: z.string().nullish(),

  // Core properties
  type: z.string(),
  name: z.string(),
  environment: z.string().default(DEFAULT_TRACE_ENVIRONMENT),
  version: z.string().nullish(),
  level: z.string().default(ObservationLevel.DEFAULT),
  status_message: z.string().nullish(),

  // Trace-level properties
  trace_name: z.string().nullish(),
  user_id: z.string().nullish(),
  session_id: z.string().nullish(),
  // Root-span flag. Our `spans` table precomputes this as the numeric
  // `is_root` (1 = trace root, 0 = child, derived at ingestion from the empty
  // `parent_span_id`), while upstream's `is_app_root` is a boolean. Normalise
  // both spellings to a boolean here: the in-memory filter comparison is a
  // strict `===` against the filter's boolean value, and observation payloads
  // written before this field existed simply default to `false`.
  is_root: z
    .union([z.boolean(), z.number()])
    .nullish()
    .transform((value) => value === true || value === 1),
  tags: z.array(z.string()).default([]),
  release: z.string().nullish(),

  // Model
  provided_model_name: z.string().nullish(),
  model_parameters: z.unknown().nullish(),

  // Prompt
  prompt_id: z.string().nullish(),
  prompt_name: z.string().nullish(),
  // Accepts string, number, or any other type from ingestion
  prompt_version: z.union([z.string().nullish(), z.number().nullish()]),

  // Usage & Cost - accepts number values directly from ingestion
  provided_usage_details: flexibleUsageCostSchema,
  provided_cost_details: flexibleUsageCostSchema,
  usage_details: flexibleUsageCostSchema,
  cost_details: flexibleUsageCostSchema,

  // Tool calls
  tool_definitions: z.record(z.string(), z.unknown()).default({}),
  tool_calls: z.array(z.unknown()).default([]),
  tool_call_names: z.array(z.string()).default([]),
  // Tool-call COUNT, the numeric form the eval filter registry exposes as
  // `toolCalls`. This fork stores only the arrays (there is no
  // `tool_call_count` column), so the value is derived — never read from
  // storage — at the points where an `ObservationForEval` is built, from
  // `tool_call_names`, which is authoritative for count and order (ingestion
  // writes both arrays in lockstep; see `zipObservationToolCalls`). This is
  // upstream's own derivation, and it equals the display layer's
  // `length(o.tool_calls)`.
  tool_call_count: z.number().default(0),

  // Experiment
  experiment_id: z.string().nullish(),
  experiment_name: z.string().nullish(),
  experiment_description: z.string().nullish(),
  experiment_dataset_id: z.string().nullish(),
  experiment_item_id: z.string().nullish(),
  experiment_item_expected_output: z.string().nullish(),
  // Added for the evaluators v2 migration (copied from upstream).

  experiment_item_metadata: z.record(z.string(), z.unknown()).nullish(),
  experiment_item_root_span_id: z.string().nullish(),

  // Data - accepts any type (string, array, object) from different OTEL SDKs
  input: z.unknown().nullish(),
  output: z.unknown().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

export type ObservationForEval = z.infer<typeof observationForEvalSchema>;

export function convertEventRecordToObservationForEval(
  record: EventRecordBaseType,
): ObservationForEval {
  // The live OTel path builds the eval-facing observation straight from the
  // ingested event record, so this is where the derived tool-call count is
  // attached (mirrors upstream). `experiment_item_root_span_id` needs no
  // derivation here: the record carries the raw id and
  // `mapEventEvalFilterColumnIdToField` compares it with `span_id`.
  const toolCallNames = record.tool_call_names ?? [];
  return observationForEvalSchema.parse({
    ...record,
    tool_call_count: toolCallNames.length,
  });
}

export type ObservationEvalFilterColumnInternal =
  /** Column identifier (must match an ObservationForEval field name) */
  keyof Pick<
    ObservationForEval,
    | "type"
    | "name"
    | "environment"
    | "level"
    | "version"
    | "trace_name"
    | "user_id"
    | "session_id"
    | "tags"
    | "experiment_dataset_id"
    | "metadata"
    | "parent_span_id"
    | "is_root"
    // ── Added for the evaluators v2 migration ──────────────────────────────
    // Upstream's filter registry declares these; this fork already carried every
    // one of them in `observationForEvalSchema` (and the evaluators-v2 rule UI,
    // copied from upstream, still writes filters against them), but they were
    // missing from the registry, so those filters were silently classified as
    // unsupported and dropped. `getObservationColumnValue` reads
    // `observation[internal]`, so declaring them here is all the data path needs.
    //
    // Two of them have no storage counterpart and are therefore derived instead
    // of read (see `mapEventEvalFilterColumnIdToField` and every projection that
    // builds an `ObservationForEval`):
    //   * `experiment_item_root_span_id` backs upstream's boolean
    //     `isExperimentItemRootSpan`; ours is a string id, so the boolean is
    //     "span_id === experiment_item_root_span_id".
    //   * `tool_call_count` backs upstream's numeric `toolCalls`; ours is the
    //     `tool_calls`/`tool_call_names` array length.
    | "release"
    | "status_message"
    | "provided_model_name"
    | "prompt_name"
    | "prompt_version"
    | "experiment_id"
    | "experiment_name"
    | "experiment_item_root_span_id"
    | "tool_call_names"
    | "tool_call_count"
  >;

export type ObservationEvalMappingColumnInternal = keyof Pick<
  ObservationForEval,
  // "tool_calls" and "experiment_item_metadata" added with the evaluators v2
  // migration (copied from upstream).
  | "input"
  | "output"
  | "metadata"
  | "tool_calls"
  | "experiment_item_expected_output"
  | "experiment_item_metadata"
>;

export interface ObservationEvalVariableColumn {
  /** Column identifier (must match an ObservationForEval field name) */
  id: string;
  /** Display name for UI */
  name: string;
  /** Description for UI tooltips */
  description: string;
  /** Optional type hint for special handling (e.g., stringObject for metadata) */
  type?: "stringObject";
  internal: ObservationEvalMappingColumnInternal;
}

/**
 * Columns available for variable extraction in observation-based evals.
 * These are the fields that can be mapped to template variables.
 *
 * When configuring an eval, users can map these columns to template
 * variables like {{input}}, {{output}}, {{expected_output}}, etc.
 */
export const observationEvalVariableColumns: ObservationEvalVariableColumn[] = [
  {
    id: "input",
    name: "Input",
    description: "Observation input data",
    internal: "input",
  },
  {
    id: "output",
    name: "Output",
    description: "Observation output data",
    internal: "output",
  },
  {
    id: "metadata",
    name: "Metadata",
    description: "Observation metadata",
    type: "stringObject",
    internal: "metadata",
  },
  {
    id: "experimentItemExpectedOutput",
    name: "Expected Output",
    description: "Expected output from experiment item",
    internal: "experiment_item_expected_output",
  },
];

export const availableObservationEvalVariableColumns = [
  ...observationEvalVariableColumns,
  {
    id: "toolCalls",
    name: "Tool Calls",
    description: "Tool calls",
    internal: "tool_calls",
  },
  {
    id: "toolDefinitions",
    name: "Tool Definitions",
    description: "Tool definitions",
    internal: "tool_definitions",
  },
  {
    id: "toolCallNames",
    name: "Tool Call Names",
    description: "Tool call names",
    internal: "tool_call_names",
  },
  {
    id: "providedModelName",
    name: "Model",
    description: "Model",
    internal: "provided_model_name",
  },
  {
    id: "modelParameters",
    name: "Model Parameters",
    description: "Model parameters",
    internal: "model_parameters",
  },
  {
    id: "usageDetails",
    name: "Usage Details",
    description: "Usage details",
    internal: "usage_details",
  },
  {
    id: "costDetails",
    name: "Cost Details",
    description: "Cost details",
    internal: "cost_details",
  },
];

type ObservationEvalColumnDef = ColumnDefinition & {
  internal: ObservationEvalFilterColumnInternal;
};

/**
 * Columns available for filtering in observation-based evals.
 *
 * These columns can be used in filter conditions to determine
 * which observations should be evaluated.
 */
export const observationEvalFilterColumns: ObservationEvalColumnDef[] = [
  {
    name: "Type",
    id: "type",
    type: "stringOptions",
    internal: "type",
    options: Object.values(ObservationType).map((key) => ({ value: key })),
  },
  {
    name: "Name",
    id: "name",
    type: "stringOptions",
    internal: "name",
    options: [], // to be filled at runtime
  },
  {
    name: "Environment",
    id: "environment",
    type: "stringOptions",
    internal: "environment",
    options: [], // to be filled at runtime
  },
  {
    name: "Level",
    id: "level",
    type: "stringOptions",
    internal: "level",
    options: Object.values(ObservationLevel).map((key) => ({ value: key })),
  },
  {
    name: "Version",
    id: "version",
    type: "string",
    internal: "version",
    nullable: true,
  },
  // ── Added for the evaluators v2 migration (upstream declares these) ────────
  // Without them the copied evaluators-v2 rule UI offered filters that the
  // registry then classified as unsupported and dropped silently. Both are
  // equivalent substitutions over columns we already have (no storage change):
  // see the derivation note on `ObservationEvalFilterColumnInternal` and the
  // branches in `mapEventEvalFilterColumnIdToField`.
  {
    name: "Release",
    id: "release",
    type: "string",
    internal: "release",
    nullable: true,
  },
  {
    name: "Status Message",
    id: "statusMessage",
    type: "string",
    internal: "status_message",
    nullable: true,
  },
  {
    name: "Provided Model Name",
    id: "providedModelName",
    type: "string",
    internal: "provided_model_name",
    nullable: true,
  },
  {
    name: "Prompt Name",
    id: "promptName",
    type: "string",
    internal: "prompt_name",
    nullable: true,
  },
  {
    name: "Prompt Version",
    id: "promptVersion",
    type: "number",
    internal: "prompt_version",
    nullable: true,
  },
  {
    name: "Experiment ID",
    id: "experimentId",
    type: "stringOptions",
    internal: "experiment_id",
    options: [], // to be filled at runtime
    nullable: true,
  },
  {
    name: "Experiment Name",
    id: "experimentName",
    type: "string",
    internal: "experiment_name",
    nullable: true,
  },
  {
    name: "Called Tool Names",
    id: "calledToolNames",
    type: "arrayOptions",
    internal: "tool_call_names",
    options: [], // to be filled at runtime
  },
  {
    name: "Trace Name",
    id: "traceName",
    type: "stringOptions",
    internal: "trace_name",
    options: [], // to be filled at runtime
    nullable: true,
  },
  {
    name: "User ID",
    id: "userId",
    type: "string",
    internal: "user_id",
    nullable: true,
  },
  {
    name: "Session ID",
    id: "sessionId",
    type: "string",
    internal: "session_id",
    nullable: true,
  },
  {
    name: "Tags",
    id: "tags",
    type: "arrayOptions",
    internal: "tags",
    options: [], // to be filled at runtime
  },
  {
    name: "Metadata",
    id: "metadata",
    type: "stringObject",
    internal: "metadata",
  },
  {
    // Upstream's spelling of "root spans" for rules, the sample selector and
    // the new-rule dialog's default filter (`{column: "isRootObservation",
    // type: "boolean", operator: "=", value: true}`). Backed by our precomputed
    // root flag, normalised to a boolean by the schema field above.
    name: "Is Root Observation",
    id: "isRootObservation",
    type: "boolean",
    internal: "is_root",
  },
  {
    // Upstream's boolean "is this row the root span of an experiment item?".
    // The internal key is upstream's (the raw string column); the boolean value
    // is derived in `mapEventEvalFilterColumnIdToField`.
    name: "Is Experiment Item Root Span",
    id: "isExperimentItemRootSpan",
    type: "boolean",
    internal: "experiment_item_root_span_id",
  },
  {
    // Upstream's numeric tool-call count. `internal` carries the derived count
    // (see the schema field and every projection that builds an
    // `ObservationForEval`).
    name: "Tool Call Count",
    id: "toolCalls",
    type: "number",
    internal: "tool_call_count",
  },
  {
    name: "Parent Observation",
    id: "parentObservationId",
    type: "null",
    internal: "parent_span_id",
    nullable: true,
  },
];

export const experimentEvalFilterColumns: ObservationEvalColumnDef[] = [
  {
    name: "Dataset",
    id: "experimentDatasetId",
    type: "stringOptions",
    internal: "experiment_dataset_id",
    options: [], // to be filled at runtime
  },
];

export const eventsEvalFilterColumns: ObservationEvalColumnDef[] = [
  ...observationEvalFilterColumns,
  ...experimentEvalFilterColumns,
];

// Options type for observation eval filters
export type ObservationEvalOptions = {
  environment?: Array<SingleValueOption>;
  tags?: Array<SingleValueOption>;
  traceName?: Array<SingleValueOption>;
  name?: Array<SingleValueOption>;
};

export type ExperimentEvalOptions = {
  experimentDatasetId?: Array<SingleValueOption>;
};

export function observationEvalFilterColsWithOptions(
  options?: ObservationEvalOptions,
  cols: ColumnDefinition[] = observationEvalFilterColumns,
): ColumnDefinition[] {
  return cols.map((col) => {
    if (col.id === "environment") {
      return formatColumnOptions(col, options?.environment ?? []);
    }
    if (col.id === "tags") {
      return formatColumnOptions(col, options?.tags ?? []);
    }
    if (col.id === "traceName") {
      return formatColumnOptions(col, options?.traceName ?? []);
    }
    if (col.id === "name") {
      return formatColumnOptions(col, options?.name ?? []);
    }
    return col;
  });
}

export function experimentEvalFilterColsWithOptions(
  options?: ExperimentEvalOptions,
  cols: ColumnDefinition[] = experimentEvalFilterColumns,
): ColumnDefinition[] {
  return cols.map((col) => {
    if (col.id === "experimentDatasetId") {
      return formatColumnOptions(col, options?.experimentDatasetId ?? []);
    }
    return col;
  });
}

/**
 * Field mapper for observation eval filters.
 * Maps camelCase filter column IDs to snake_case observation fields.
 * Based on events table column definitions.
 *
 * @param observation - The observation data object
 * @param column - The camelCase column ID from filter definitions
 * @returns The value from the observation object
 */
export function mapEventEvalFilterColumnIdToField(
  observation: ObservationForEval,
  column: string,
) {
  const columnMapping = eventsEvalFilterColumns.find((c) => c.id === column);
  if (!columnMapping) {
    return undefined;
  }

  // `isExperimentItemRootSpan` has no boolean column behind it in this fork: the
  // stored fact is the item's root span ID (a string), so the upstream boolean
  // is "this row is its own item root". Deriving it here — the single mapping
  // point every in-memory filter evaluation goes through, whichever projection
  // built the observation — mirrors upstream and guarantees the strict `===`
  // comparison in `InMemoryFilterService` sees a real boolean. Rows without an
  // item root (`null`/`undefined`, and `''` by way of the id comparison) are
  // `false`, exactly like upstream. Retrieval-only: no storage change.
  if (columnMapping.id === "isExperimentItemRootSpan") {
    return (
      observation.experiment_item_root_span_id != null &&
      observation.experiment_item_root_span_id === observation.span_id
    );
  }

  return observation[columnMapping.internal];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call + code-eval variable cluster. Copied from upstream; our fork predates
// it. Needed by server/evals/extractObservationVariables.ts and the v2 UI.
// ─────────────────────────────────────────────────────────────────────────────

export const toolCallForEvalSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
  type: z.string(),
  index: z.number(),
});

export type ToolCallForEval = z.infer<typeof toolCallForEvalSchema>;

/**
 * Zips the parallel arrays back into named tool call objects.
 * \`tool_call_names\` is authoritative for count and order: ingestion writes
 * both arrays in lockstep, and stored entries carry no name. \`arguments\` arrives
 * double-encoded (a JSON string inside the entry JSON) and is parsed to an
 * object; unparsable values stay raw strings.
 */
export function zipObservationToolCalls(
  observation: Pick<ObservationForEval, "tool_calls" | "tool_call_names">,
): ToolCallForEval[] {
  return observation.tool_call_names.map((name, i) => {
    const parsed = parseJsonIfString(observation.tool_calls[i]);
    const entry =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};

    return {
      id: typeof entry.id === "string" ? entry.id : "",
      name,
      arguments: parseJsonIfString(entry.arguments) ?? {},
      type: typeof entry.type === "string" ? entry.type : "",
      index: typeof entry.index === "number" ? entry.index : 0,
    };
  });
}

export function zipToolCallsFromRecord(record: object): ToolCallForEval[] {
  const { toolCalls, toolCallNames } = record as {
    toolCalls?: unknown;
    toolCallNames?: unknown;
  };

  return zipObservationToolCalls({
    tool_calls: Array.isArray(toolCalls) ? toolCalls : [],
    tool_call_names: Array.isArray(toolCallNames)
      ? toolCallNames.map((name) => (typeof name === "string" ? name : ""))
      : [],
  });
}

/**
 * Canonical variable set for code evaluators — one entry per experiment target
 * column below (the id annotation on the column arrays pins them to this list).
 */
export const CODE_EVAL_TEMPLATE_VARIABLES = [
  "input",
  "output",
  "metadata",
  "toolCalls",
  "experimentItemExpectedOutput",
  "experimentItemMetadata",
] as const;

export type CodeEvalTemplateVariable =
  (typeof CODE_EVAL_TEMPLATE_VARIABLES)[number];

export function getCodeEvalVariableMapping() {
  return CODE_EVAL_TEMPLATE_VARIABLES.map((variable) => ({
    templateVariable: variable,
    selectedColumnId: variable,
    jsonSelector: null,
  }));
}

export const eventTargetEvalVariableColumns: (ObservationEvalVariableColumn & {
  id: CodeEvalTemplateVariable;
})[] = [
  {
    id: "input",
    name: "Input",
    description: "Observation input data",
    internal: "input",
  },
  {
    id: "output",
    name: "Output",
    description: "Observation output data",
    internal: "output",
  },
  {
    id: "metadata",
    name: "Metadata",
    description: "Observation metadata",
    type: "stringObject",
    internal: "metadata",
  },
  {
    id: "toolCalls",
    name: "Tool Calls",
    description:
      "Tool calls recorded on the observation ({id, name, arguments, type, index})",
    internal: "tool_calls",
  },
];

export const experimentTargetEvalVariableColumns: (ObservationEvalVariableColumn & {
  id: CodeEvalTemplateVariable;
})[] = [
  ...eventTargetEvalVariableColumns,
  {
    id: "experimentItemExpectedOutput",
    name: "Expected Output",
    description: "Expected output from experiment item",
    internal: "experiment_item_expected_output",
  },
  {
    id: "experimentItemMetadata",
    name: "Experiment Item Metadata",
    description: "Metadata from experiment item",
    type: "stringObject",
    internal: "experiment_item_metadata",
  },
];
