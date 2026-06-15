import {
  createPublicApiObservationsColumnMapping,
  deriveFilters,
  type ObservationRecordReadType,
  queryDoris,
  measureAndReturn,
  observationsTableUiColumnDefinitionsForDoris,
  convertObservation,
  convertDateToAnalyticsDateTime,
  dq,
  zipDorisMetadataArrays,
} from "@langfuse/shared/src/server";
import { type FilterState, observationsTableCols } from "@langfuse/shared";

type QueryType = {
  page: number;
  limit: number;
  projectId: string;
  traceId?: string;
  userId?: string;
  name?: string;
  type?: string;
  parentObservationId?: string;
  fromStartTime?: string;
  toStartTime?: string;
  version?: string;
  advancedFilters?: FilterState;
};

export const generateObservationsForPublicApi = async (props: QueryType) => {
  const chFilter = generateFilter(props);
  // Trace-table filters live inside the EXISTS subquery (where `t` is in
  // scope). The fork uses EXISTS instead of LEFT JOIN to dodge a Doris
  // Nereids optimizer crash on LEFT JOIN + map expressions; re-applying
  // them in the outer WHERE would reference an undefined `t` alias.
  // events_full root-span rows (parent_span_id = '') stand in for legacy
  // traces table.
  const traceFilters = chFilter.filter((f) => f.table === "traces");
  const observationFilters = chFilter.filter((f) => f.table !== "traces");
  const appliedObservationFilter = observationFilters.apply();
  const appliedTraceFilter =
    traceFilters.length() > 0 ? traceFilters.apply() : null;

  const query = `
    SELECT
      o.span_id AS id,
      o.trace_id,
      o.project_id,
      o.type,
      o.parent_span_id AS parent_observation_id,
      o.environment,
      o.start_time,
      o.end_time,
      o.name,
      o.metadata_names,
      o.metadata_values,
      o.level,
      o.status_message,
      o.version,
      o.input,
      o.output,
      o.provided_model_name,
      o.model_id AS internal_model_id,
      o.model_parameters,
      o.provided_usage_details,
      o.usage_details,
      o.provided_cost_details,
      o.cost_details,
      o.total_cost,
      o.completion_start_time,
      o.prompt_id,
      o.prompt_name,
      o.prompt_version,
      o.created_at,
      o.updated_at,
      o.event_ts
    FROM events_full o
    WHERE o.project_id = {projectId: String}
      ${appliedTraceFilter ? `AND EXISTS (SELECT 1 FROM events_full t WHERE o.trace_id = t.trace_id AND t.project_id = o.project_id AND t.parent_span_id = '' AND ${appliedTraceFilter.query})` : ""}
      ${appliedObservationFilter.query ? `AND ${appliedObservationFilter.query}` : ""}
    ORDER BY o.start_time DESC
    ${props.limit !== undefined && props.page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
  `;

  return measureAndReturn({
    operationName: "generateObservationsForPublicApi",
    projectId: props.projectId,
    input: {
      params: {
        ...appliedObservationFilter.params,
        ...(appliedTraceFilter ? appliedTraceFilter.params : {}),
        projectId: props.projectId,
        ...(props.limit !== undefined ? { limit: props.limit } : {}),
        ...(props.page !== undefined
          ? { offset: (props.page - 1) * props.limit }
          : {}),
      },
      tags: {
        feature: "tracing",
        type: "observation",
        projectId: props.projectId,
        operation_name: "generateObservationsForPublicApi",
      },
    },
    fn: async (input) => {
      const result = await queryDoris<
        Omit<ObservationRecordReadType, "metadata"> & {
          metadata_names: unknown;
          metadata_values: unknown;
        }
      >({
        query,
        params: input.params,
        tags: input.tags,
      });
      return result.map((r) => {
        const { metadata_names, metadata_values, ...rest } = r;
        return convertObservation({
          ...rest,
          metadata: zipDorisMetadataArrays(metadata_names, metadata_values),
        } as ObservationRecordReadType);
      });
    },
  });
};

export const getObservationsCountForPublicApi = async (props: QueryType) => {
  const chFilter = generateFilter(props);
  const traceFilters = chFilter.filter((f) => f.table === "traces");
  const observationFilters = chFilter.filter((f) => f.table !== "traces");
  const appliedObservationFilter = observationFilters.apply();
  const appliedTraceFilter =
    traceFilters.length() > 0 ? traceFilters.apply() : null;

  const query = `
    SELECT count(*) as count
    FROM events_full o
    WHERE o.project_id = {projectId: String}
    ${appliedTraceFilter ? `AND EXISTS (SELECT 1 FROM events_full t WHERE o.trace_id = t.trace_id AND t.project_id = o.project_id AND t.parent_span_id = '' AND ${appliedTraceFilter.query})` : ""}
    ${appliedObservationFilter.query ? `AND ${appliedObservationFilter.query}` : ""}
  `;

  return measureAndReturn({
    operationName: "getObservationsCountForPublicApi",
    projectId: props.projectId,
    input: {
      params: {
        ...appliedObservationFilter.params,
        ...(appliedTraceFilter ? appliedTraceFilter.params : {}),
        projectId: props.projectId,
      },
      tags: {
        feature: "tracing",
        type: "observation",
        projectId: props.projectId,
        operation_name: "getObservationsCountForPublicApi",
      },
    },
    fn: async (input) => {
      const records = await queryDoris<{ count: string }>({
        query,
        params: input.params,
        tags: input.tags,
      });
      return records.map((record) => Number(record.count)).shift();
    },
  });
};

const filterParams = createPublicApiObservationsColumnMapping(
  "observations",
  "o",
  "parent_span_id",
);

const generateFilter = (query: QueryType) => {
  const { advancedFilters, ...simpleFilterProps } = query;
  const chFilter = deriveFilters(
    simpleFilterProps,
    filterParams,
    advancedFilters,
    observationsTableUiColumnDefinitionsForDoris.filter(
      (c) => c.tableName !== "scores",
    ),
    observationsTableCols,
  );

  // Remove score filters since observations don't support scores in response.
  // We intentionally do NOT push a project_id StringFilter here — the SQL
  // template hardcodes `WHERE o.project_id = {projectId: String}`. Pushing
  // one without `tablePrefix` would render as bare `project_id = '...'`
  // which Doris rejects with "project_id is ambiguous" the moment we JOIN
  // events_full as `t` (e.g. when userId filter is set).
  return chFilter.filter((f) => f.table !== "scores");
};
