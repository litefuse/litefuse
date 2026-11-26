import { env } from "../../env";
import { dorisClient, formatDataForDoris } from "../doris/client";
import { buildSplitTableStatements } from "../doris/splitTableTemplates";
import { tableFor } from "../doris/tableRouting";
import { commandDoris } from "../repositories/doris";
import {
  type DatasetRunItemRecordInsertType,
  type EventRecordInsertType,
  type ObservationRecordInsertType,
  type ScoreRecordInsertType,
  type TraceRecordInsertType,
} from "../repositories/definitions";
import {
  deleteTraceSpans,
  standInRootSpanId,
  writeObservationSpans,
  writeTraceRecordSpans,
} from "./doris-trace-roots";
import { createObservation, createTrace } from "./tracing-factory";

const STREAM_LOAD_OPTS = {
  format: "json" as const,
  strip_outer_array: true,
  read_json_by_line: false,
  max_filter_ratio: 0.1,
  timeout: 120,
};

const STREAM_LOAD_CHUNK_SIZE = 5_000;

const streamLoadChunked = async (
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> => {
  for (let i = 0; i < rows.length; i += STREAM_LOAD_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + STREAM_LOAD_CHUNK_SIZE);
    await dorisClient().streamLoad(
      table,
      formatDataForDoris(chunk, table),
      STREAM_LOAD_OPTS,
    );
  }
};

const toNullableString = (val: unknown): string | null => {
  if (val === null || val === undefined) return null;
  return typeof val === "string" ? val : JSON.stringify(val);
};

type TimestampInput = number | string | Date | null | undefined;

const toMs = (val: TimestampInput): number | null => {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.getTime();
  if (typeof val === "number") {
    // EventRecordInsertType uses microsecond epoch numbers (Date.now() * 1000).
    return val > 1e14 ? Math.floor(val / 1000) : val;
  }
  if (typeof val === "string") {
    const normalized =
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(val) && !val.endsWith("Z")
        ? val.replace(" ", "T") + "Z"
        : val;
    const ms = Date.parse(normalized);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
};

const groupByProjectId = <T extends { project_id: string }>(
  records: T[],
): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const existing = groups.get(record.project_id);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(record.project_id, [record]);
    }
  }
  return groups;
};

/**
 * Idempotently provision per-project Doris split tables (`spans_<pid>` and
 * `traces_scalar_<pid>`) for tests. Uses CREATE TABLE IF NOT EXISTS directly
 * so it remains safe even after `dropSplitTablesForProject`.
 */
export const provisionDorisTestProject = async (
  projectId: string,
): Promise<void> => {
  const { spans, tracesScalar } = buildSplitTableStatements({
    projectId,
    retentionDays: null,
    replication: env.DORIS_REPLICATION_NUM,
    storagePageSize: env.LITEFUSE_STORAGE_PAGE_SIZE,
  });
  await commandDoris({
    query: spans,
    tags: { feature: "test-utils", kind: "provision-spans", projectId },
  });
  await commandDoris({
    query: tracesScalar,
    tags: { feature: "test-utils", kind: "provision-traces-scalar", projectId },
  });
};

type FlexibleTraceInput = Omit<
  TraceRecordInsertType,
  "timestamp" | "created_at" | "updated_at" | "event_ts"
> & {
  timestamp?: TimestampInput;
  created_at?: TimestampInput;
  updated_at?: TimestampInput;
  event_ts?: TimestampInput;
};

export const createTracesCh = async (
  traces: FlexibleTraceInput[],
): Promise<void> => {
  if (traces.length === 0) return;

  const byProject = groupByProjectId(traces);
  for (const [projectId, projectTraces] of byProject.entries()) {
    await provisionDorisTestProject(projectId);

    const spansRows: Record<string, unknown>[] = [];
    const scalarRows: Record<string, unknown>[] = [];

    for (const trace of projectTraces) {
      if (trace.is_deleted === 1) continue;
      const startTime = toMs(trace.timestamp) ?? Date.now();
      const createdAt = toMs(trace.created_at) ?? startTime;
      const updatedAt = toMs(trace.updated_at) ?? createdAt;
      const inputStr = toNullableString(trace.input);
      const outputStr = toNullableString(trace.output);
      const inputTrim = inputStr ? inputStr.slice(0, 500) : null;
      const outputTrim = outputStr ? outputStr.slice(0, 500) : null;

      spansRows.push({
        trace_id: trace.id,
        start_time: startTime,
        span_id: standInRootSpanId(trace.id),
        project_id: projectId,
        parent_span_id: "",
        is_root: 1,
        end_time: startTime,
        name: trace.name ?? null,
        trace_name: trace.name ?? null,
        type: "SPAN",
        environment: trace.environment ?? "default",
        version: trace.version ?? null,
        release: trace.release ?? null,
        level: "DEFAULT",
        user_id: trace.user_id ?? null,
        session_id: trace.session_id ?? null,
        tags: trace.tags ?? [],
        bookmarked: trace.bookmarked ?? false,
        public: trace.public ?? false,
        input: inputStr,
        output: outputStr,
        input_trim: inputTrim,
        output_trim: outputTrim,
        metadata: trace.metadata ?? {},
        source: "API",
        created_at: createdAt,
      });

      scalarRows.push({
        id: trace.id,
        start_time: startTime,
        project_id: projectId,
        end_time: startTime,
        name: trace.name ?? null,
        user_id: trace.user_id ?? null,
        session_id: trace.session_id ?? null,
        release: trace.release ?? null,
        version: trace.version ?? null,
        environment: trace.environment ?? "default",
        bookmarked: trace.bookmarked ?? false,
        public: trace.public ?? false,
        tags: trace.tags ?? [],
        metadata: trace.metadata ?? {},
        input_trim: inputTrim,
        output_trim: outputTrim,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    }

    if (scalarRows.length === 0) continue;

    const spansTable = tableFor(projectId, "spans");
    const scalarTable = tableFor(projectId, "traces_scalar");

    await writeTraceRecordSpans({
      projectId,
      standIns: spansRows,
      load: (rows) => streamLoadChunked(spansTable, rows),
    });
    await streamLoadChunked(scalarTable, scalarRows);
  }
};

type FlexibleObservationInput = Omit<
  ObservationRecordInsertType,
  | "start_time"
  | "end_time"
  | "completion_start_time"
  | "created_at"
  | "updated_at"
  | "event_ts"
> & {
  start_time?: TimestampInput;
  end_time?: TimestampInput;
  completion_start_time?: TimestampInput;
  created_at?: TimestampInput;
  updated_at?: TimestampInput;
  event_ts?: TimestampInput;
};

export const createObservationsCh = async (
  observations: FlexibleObservationInput[],
): Promise<void> => {
  if (observations.length === 0) return;

  const byProject = groupByProjectId(observations);
  for (const [projectId, projectObs] of byProject.entries()) {
    await provisionDorisTestProject(projectId);

    const spansRows: Record<string, unknown>[] = [];
    for (const obs of projectObs) {
      if (obs.is_deleted === 1) continue;
      const startTime = toMs(obs.start_time) ?? Date.now();
      const createdAt = toMs(obs.created_at) ?? startTime;
      const inputStr = toNullableString(obs.input);
      const outputStr = toNullableString(obs.output);
      const usageDetails = obs.usage_details ?? {};
      const costDetails = obs.cost_details ?? {};
      const totalCost =
        obs.total_cost ??
        (costDetails.total !== undefined ? Number(costDetails.total) : null);

      spansRows.push({
        trace_id: obs.trace_id ?? "",
        start_time: startTime,
        span_id: obs.id,
        project_id: projectId,
        parent_span_id: obs.parent_observation_id ?? "",
        is_root: (obs.parent_observation_id ?? "") === "" ? 1 : 0,
        end_time: toMs(obs.end_time),
        completion_start_time: toMs(obs.completion_start_time),
        name: obs.name ?? null,
        type: obs.type,
        environment: obs.environment ?? "default",
        version: obs.version ?? null,
        level: obs.level ?? "DEFAULT",
        status_message: obs.status_message ?? null,
        prompt_id: obs.prompt_id ?? null,
        prompt_name: obs.prompt_name ?? null,
        prompt_version: obs.prompt_version ?? null,
        model_id: obs.internal_model_id ?? null,
        provided_model_name: obs.provided_model_name ?? null,
        model_parameters: obs.model_parameters ?? null,
        provided_usage_details: obs.provided_usage_details ?? {},
        usage_details: usageDetails,
        provided_cost_details: obs.provided_cost_details ?? {},
        cost_details: costDetails,
        total_cost: totalCost,
        input_tokens_calculated:
          usageDetails.input !== undefined ? Number(usageDetails.input) : null,
        output_tokens_calculated:
          usageDetails.output !== undefined
            ? Number(usageDetails.output)
            : null,
        total_tokens_calculated:
          usageDetails.total !== undefined ? Number(usageDetails.total) : null,
        input_cost_calculated:
          costDetails.input !== undefined ? Number(costDetails.input) : null,
        output_cost_calculated:
          costDetails.output !== undefined ? Number(costDetails.output) : null,
        usage_pricing_tier_id: obs.usage_pricing_tier_id ?? null,
        usage_pricing_tier_name: obs.usage_pricing_tier_name ?? null,
        tool_definitions: obs.tool_definitions ?? {},
        tool_calls: obs.tool_calls ?? [],
        tool_call_names: obs.tool_call_names ?? [],
        input: inputStr,
        output: outputStr,
        input_trim: inputStr ? inputStr.slice(0, 500) : null,
        output_trim: outputStr ? outputStr.slice(0, 500) : null,
        metadata: obs.metadata ?? {},
        source: "API",
        created_at: createdAt,
      });
    }

    if (spansRows.length === 0) continue;

    const spansTable = tableFor(projectId, "spans");
    await writeObservationSpans({
      projectId,
      rows: spansRows,
      mergeTraceFields: true,
      load: (rows) => streamLoadChunked(spansTable, rows),
    });
  }
};

export const createEventsCh = async (
  events: EventRecordInsertType[],
): Promise<void> => {
  if (events.length === 0) return;

  const byProject = groupByProjectId(events);
  for (const [projectId, projectEvents] of byProject.entries()) {
    await provisionDorisTestProject(projectId);

    const spansRows: Record<string, unknown>[] = [];
    const scalarRows: Record<string, unknown>[] = [];

    for (const event of projectEvents) {
      const startTime = toMs(event.start_time) ?? Date.now();
      const endTime = toMs(event.end_time);
      const createdAt = toMs(event.created_at) ?? startTime;
      const isRoot =
        event.is_root ??
        (!event.parent_span_id || event.parent_span_id === "" ? 1 : 0);
      const inputStr = toNullableString(event.input);
      const outputStr = toNullableString(event.output);
      const inputTrim =
        event.input_trim ?? (inputStr ? inputStr.slice(0, 500) : null);
      const outputTrim =
        event.output_trim ?? (outputStr ? outputStr.slice(0, 500) : null);

      const { id: eventId, ...rest } = event;
      spansRows.push({
        ...rest,
        project_id: projectId,
        span_id: event.span_id ?? eventId,
        parent_span_id: event.parent_span_id ?? "",
        is_root: isRoot,
        start_time: startTime,
        end_time: endTime,
        completion_start_time: toMs(event.completion_start_time),
        experiment_item_version: toMs(event.experiment_item_version),
        created_at: createdAt,
        input: inputStr,
        output: outputStr,
        input_trim: inputTrim,
        output_trim: outputTrim,
        metadata: event.metadata ?? {},
        experiment_metadata: event.experiment_metadata ?? {},
        experiment_item_metadata: event.experiment_item_metadata ?? {},
      });

      if (isRoot === 1 && event.trace_id) {
        scalarRows.push({
          id: event.trace_id,
          start_time: startTime,
          project_id: projectId,
          end_time: endTime,
          name: event.trace_name ?? event.name ?? null,
          user_id: event.user_id ?? null,
          session_id: event.session_id ?? null,
          release: event.release ?? null,
          version: event.version ?? null,
          environment: event.environment ?? "default",
          bookmarked: event.bookmarked ?? false,
          public: event.public ?? false,
          tags: event.tags ?? [],
          metadata: event.metadata ?? {},
          input_trim: inputTrim,
          output_trim: outputTrim,
          created_at: createdAt,
          updated_at: createdAt,
        });
      }
    }

    const spansTable = tableFor(projectId, "spans");
    await writeObservationSpans({
      projectId,
      rows: spansRows,
      mergeTraceFields: false,
      load: (rows) => streamLoadChunked(spansTable, rows),
    });

    if (scalarRows.length > 0) {
      const scalarTable = tableFor(projectId, "traces_scalar");
      await streamLoadChunked(scalarTable, scalarRows);
    }
  }
};

type FlexibleScoreInput = Omit<
  ScoreRecordInsertType,
  "timestamp" | "created_at" | "updated_at" | "event_ts"
> & {
  timestamp?: TimestampInput;
  created_at?: TimestampInput;
  updated_at?: TimestampInput;
  event_ts?: TimestampInput;
};

export const createScoresCh = async (
  scores: FlexibleScoreInput[],
): Promise<void> => {
  if (scores.length === 0) return;

  const projectIds = new Set(scores.map((s) => s.project_id));
  for (const projectId of projectIds) {
    await provisionDorisTestProject(projectId);
  }

  const rows = scores.map((score) => {
    const ts = toMs(score.timestamp) ?? Date.now();
    return {
      ...score,
      timestamp: ts,
      created_at: toMs(score.created_at) ?? ts,
      updated_at: toMs(score.updated_at) ?? ts,
      event_ts: toMs(score.event_ts) ?? ts,
      is_deleted: score.is_deleted ?? 0,
      environment: score.environment ?? "default",
      long_string_value: score.long_string_value ?? "",
    };
  });

  await streamLoadChunked("scores", rows);
};

type FlexibleDatasetRunItemInput = Omit<
  DatasetRunItemRecordInsertType,
  | "created_at"
  | "updated_at"
  | "event_ts"
  | "dataset_run_created_at"
  | "dataset_item_version"
> & {
  created_at?: TimestampInput;
  updated_at?: TimestampInput;
  event_ts?: TimestampInput;
  dataset_run_created_at?: TimestampInput;
  dataset_item_version?: TimestampInput;
};

export const createDatasetRunItemsCh = async (
  items: FlexibleDatasetRunItemInput[],
): Promise<void> => {
  if (items.length === 0) return;

  const rows = items.map((item) => {
    const now = Date.now();
    return {
      ...item,
      created_at: toMs(item.created_at) ?? now,
      updated_at: toMs(item.updated_at) ?? now,
      event_ts: toMs(item.event_ts) ?? now,
      dataset_run_created_at: toMs(item.dataset_run_created_at) ?? now,
      dataset_item_version: toMs(item.dataset_item_version),
      is_deleted: item.is_deleted ?? 0,
    };
  });

  await streamLoadChunked("dataset_run_items_rmt", rows);
};

export const upsertTrace = async (
  trace: Partial<FlexibleTraceInput> & { id: string; project_id: string },
): Promise<void> => {
  await provisionDorisTestProject(trace.project_id);
  await deleteTraceSpans({ projectId: trace.project_id, traceId: trace.id });
  await commandDoris({
    query: `DELETE FROM ${tableFor(trace.project_id, "traces_scalar")} WHERE project_id = {projectId: String} AND id = {traceId: String}`,
    params: { projectId: trace.project_id, traceId: trace.id },
    tags: { feature: "test-utils", kind: "upsert-trace-delete-scalar" },
  });
  const base = createTrace({
    id: trace.id,
    project_id: trace.project_id,
    input: null,
    output: null,
  });
  await createTracesCh([
    {
      ...base,
      ...trace,
    },
  ]);
};

export const upsertObservation = async (
  observation: Partial<FlexibleObservationInput> & {
    id: string;
    project_id: string;
  },
): Promise<void> => {
  const base = createObservation({
    id: observation.id,
    project_id: observation.project_id,
    input: null,
    output: null,
  });
  await createObservationsCh([
    {
      ...base,
      ...observation,
    },
  ]);
};
