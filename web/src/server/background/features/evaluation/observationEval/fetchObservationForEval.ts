/**
 * Read one observation row out of events_full and shape it into
 * the eval-only ObservationForEval projection.
 *
 * Replaces the old S3 round-trip: scheduling no longer uploads JSON
 * to S3, execution no longer downloads it. Both sides now read from
 * Doris directly. Read from events_full instead of the compatibility
 * view because Doris HTTP JSON responses can null out non-key columns
 * when querying the view.
 */
import {
  type DorisClientType,
  logger,
  parseDorisStringArray,
} from "@langfuse/shared/src/server";
import {
  observationForEvalSchema,
  type ObservationForEval,
} from "@langfuse/shared";

interface EventsFullRow {
  project_id: string;
  span_id: string;
  trace_id: string | null;
  parent_span_id: string | null;
  type: string;
  name: string | null;
  environment: string | null;
  version: string | null;
  level: string | null;
  status_message: string | null;
  trace_name: string | null;
  user_id: string | null;
  session_id: string | null;
  tags: unknown;
  release: string | null;
  provided_model_name: string | null;
  model_parameters: string | null;
  prompt_id: string | null;
  prompt_name: string | null;
  prompt_version: number | null;
  provided_usage_details: unknown;
  provided_cost_details: unknown;
  usage_details: unknown;
  cost_details: unknown;
  tool_definitions: unknown;
  tool_calls: unknown;
  tool_call_names: unknown;
  experiment_id: string | null;
  experiment_name: string | null;
  experiment_description: string | null;
  experiment_dataset_id: string | null;
  experiment_item_id: string | null;
  experiment_item_expected_output: string | null;
  experiment_item_root_span_id: string | null;
  input: unknown;
  output: unknown;
  metadata_names: unknown;
  metadata_values: unknown;
}

const parseMap = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

// Usage / cost details land as Doris MAP<STRING, DOUBLE>; coerce to
// Record<string, number>. NaN values are dropped — the schema parse
// downstream would reject them anyway.
const parseUsageCostMap = (value: unknown): Record<string, number> => {
  const raw = parseMap(value);
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === null || val === undefined) continue;
    const num = Number(val);
    if (!Number.isNaN(num)) result[key] = num;
  }
  return result;
};

// Tool definitions land as Doris MAP<STRING, STRING>.
const parseStringMap = (value: unknown): Record<string, string> => {
  const raw = parseMap(value);
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === null || val === undefined) continue;
    result[key] = typeof val === "string" ? val : JSON.stringify(val);
  }
  return result;
};

// input/output land as JSON-encoded text or parsed JSON objects in
// events_full.
const toNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};

const buildMetadata = (
  names: unknown,
  values: unknown,
): Record<string, string> => {
  const parsedNames = parseDorisStringArray(names);
  const parsedValues = parseDorisStringArray(values);
  const result: Record<string, string> = {};
  for (let i = 0; i < parsedNames.length; i++) {
    result[parsedNames[i]] = parsedValues[i] ?? "";
  }
  return result;
};

const rowToObservationForEval = (row: EventsFullRow): ObservationForEval =>
  observationForEvalSchema.parse({
    project_id: row.project_id,
    span_id: row.span_id,
    trace_id: row.trace_id ?? "",
    parent_span_id: row.parent_span_id,
    type: row.type,
    name: row.name ?? "",
    environment: row.environment ?? "default",
    version: row.version,
    level: row.level ?? "DEFAULT",
    status_message: row.status_message,
    trace_name: row.trace_name,
    user_id: row.user_id,
    session_id: row.session_id,
    tags: parseDorisStringArray(row.tags),
    release: row.release,
    provided_model_name: row.provided_model_name,
    model_parameters: row.model_parameters,
    prompt_id: row.prompt_id,
    prompt_name: row.prompt_name,
    prompt_version: row.prompt_version,
    provided_usage_details: parseUsageCostMap(row.provided_usage_details),
    provided_cost_details: parseUsageCostMap(row.provided_cost_details),
    usage_details: parseUsageCostMap(row.usage_details),
    cost_details: parseUsageCostMap(row.cost_details),
    tool_definitions: parseStringMap(row.tool_definitions),
    tool_calls: parseDorisStringArray(row.tool_calls),
    tool_call_names: parseDorisStringArray(row.tool_call_names),
    experiment_id: row.experiment_id,
    experiment_name: row.experiment_name,
    experiment_description: row.experiment_description,
    experiment_dataset_id: row.experiment_dataset_id,
    experiment_item_id: row.experiment_item_id,
    experiment_item_expected_output: row.experiment_item_expected_output,
    experiment_item_root_span_id: row.experiment_item_root_span_id,
    input: toNullableString(row.input),
    output: toNullableString(row.output),
    metadata: buildMetadata(row.metadata_names, row.metadata_values),
  });

const SELECT_COLUMNS = `
  project_id, span_id, trace_id, parent_span_id, type, name,
  environment, version, level, status_message, trace_name,
  user_id, session_id, tags, \`release\`,
  provided_model_name, model_parameters,
  prompt_id, prompt_name, prompt_version,
  provided_usage_details, provided_cost_details,
  usage_details, cost_details,
  tool_definitions, tool_calls, tool_call_names,
  experiment_id, experiment_name, experiment_description,
  experiment_dataset_id, experiment_item_id,
  experiment_item_expected_output, experiment_item_root_span_id,
  input, output,
  metadata_names, metadata_values
`;

/**
 * Fetch the row and convert to ObservationForEval. start_time_date is
 * required so Doris can prune by partition key (events_full is range-
 * partitioned on start_time_date). Returns null if the row is gone
 * (deleted / retained-out) — callers decide whether to skip or fail.
 */
export const fetchObservationForEval = async (
  client: DorisClientType,
  params: {
    projectId: string;
    spanId: string;
    startTimeDate: string;
    retry?: {
      maxAttempts: number;
      initialDelayMs: number;
      backoffMultiplier: number;
      maxDelayMs?: number;
    };
  },
): Promise<ObservationForEval | null> => {
  const { retry, ...queryParams } = params;
  let delay = retry?.initialDelayMs ?? 0;
  const maxAttempts = retry?.maxAttempts ?? 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.queryWithParams({
      query: `
        SELECT ${SELECT_COLUMNS}
        FROM events_full
        WHERE project_id = {projectId: String}
          AND start_time_date = {startTimeDate: String}
          AND span_id = {spanId: String}
        LIMIT 1
      `,
      query_params: queryParams,
    });
    const rows = await result.json();
    if (rows && rows.length > 0) {
      return rowToObservationForEval(rows[0] as EventsFullRow);
    }
    if (attempt === maxAttempts) break;
    logger.debug(
      `fetchObservationForEval: row not found on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (retry) {
      delay *= retry.backoffMultiplier;
      if (retry.maxDelayMs !== undefined) {
        delay = Math.min(delay, retry.maxDelayMs);
      }
    }
  }
  return null;
};
