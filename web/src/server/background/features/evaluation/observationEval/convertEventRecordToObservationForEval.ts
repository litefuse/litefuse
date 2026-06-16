import { observationForEvalSchema } from "@langfuse/shared";
import { type EventRecordInsertType } from "@langfuse/shared/src/server";

const buildMetadata = (
  names: string[],
  values: Array<string | null | undefined>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    result[names[i]] = values[i] ?? "";
  }
  return result;
};

export function convertEventRecordToObservationForEval(
  record: EventRecordInsertType,
) {
  return observationForEvalSchema.parse({
    span_id: record.span_id,
    trace_id: record.trace_id,
    project_id: record.project_id,
    parent_span_id: record.parent_span_id,
    type: record.type,
    name: record.name,
    environment: record.environment,
    version: record.version,
    level: record.level,
    status_message: record.status_message,
    trace_name: record.trace_name,
    user_id: record.user_id,
    session_id: record.session_id,
    tags: record.tags,
    release: record.release,
    provided_model_name: record.provided_model_name,
    model_parameters: record.model_parameters,
    prompt_id: record.prompt_id,
    prompt_name: record.prompt_name,
    prompt_version: record.prompt_version,
    provided_usage_details: record.provided_usage_details,
    provided_cost_details: record.provided_cost_details,
    usage_details: record.usage_details,
    cost_details: record.cost_details,
    tool_definitions: record.tool_definitions,
    tool_calls: record.tool_calls,
    tool_call_names: record.tool_call_names,
    experiment_id: record.experiment_id,
    experiment_name: record.experiment_name,
    experiment_description: record.experiment_description,
    experiment_dataset_id: record.experiment_dataset_id,
    experiment_item_id: record.experiment_item_id,
    experiment_item_expected_output: record.experiment_item_expected_output,
    experiment_item_root_span_id: record.experiment_item_root_span_id,
    input: record.input,
    output: record.output,
    metadata: buildMetadata(record.metadata_names, record.metadata_values),
  });
}
