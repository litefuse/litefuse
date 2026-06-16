import { TraceRecordExtraFieldsType, TraceRecordReadType } from "./definitions";
import { convertDateToAnalyticsDateTime } from "./analytics";
import { TraceDomain } from "../../domain";
import { parseMetadataCHRecordToDomain } from "../utils/metadata_conversion";
import {
  RenderingProps,
  DEFAULT_RENDERING_PROPS,
  applyInputOutputRendering,
} from "../utils/rendering";
import { parseDorisUTCDateTimeFormat } from "./doris";

// Helper function to parse timestamps from different backends
const parseTimestamp = (timestamp: string | Date): Date => {
  // Only apply special handling for Doris backend
  if (timestamp instanceof Date) {
    return timestamp;
  }

  // Default ClickHouse behavior - always expect string
  if (typeof timestamp === "string") {
    return parseDorisUTCDateTimeFormat(timestamp);
  }

  throw new Error(`Invalid timestamp format: ${typeof timestamp}`);
};

export const convertTraceDomainToDoris = (
  trace: TraceDomain,
): TraceRecordReadType => {
  return {
    id: trace.id,
    timestamp: convertDateToAnalyticsDateTime(trace.timestamp),
    name: trace.name,
    user_id: trace.userId,
    metadata: trace.metadata as Record<string, string>,
    environment: trace.environment,
    release: trace.release,
    version: trace.version,
    project_id: trace.projectId,
    public: trace.public,
    bookmarked: trace.bookmarked,
    tags: trace.tags,
    input: trace.input as string,
    output: trace.output as string,
    session_id: trace.sessionId,
    created_at: convertDateToAnalyticsDateTime(trace.createdAt),
    updated_at: convertDateToAnalyticsDateTime(trace.updatedAt),
    event_ts: convertDateToAnalyticsDateTime(new Date()),
    is_deleted: 0,
  };
};

export const convertDorisToDomain = (
  record: TraceRecordReadType,
  renderingProps: RenderingProps = DEFAULT_RENDERING_PROPS,
): TraceDomain => {
  // Parse tags array - handle Doris string format
  let tags: string[] = [];
  if (typeof record.tags === "string") {
    try {
      tags = JSON.parse(record.tags);
      if (!Array.isArray(tags)) {
        tags = [];
      }
    } catch (e) {
      console.error("Failed to parse tags JSON:", e);
      tags = [];
    }
  } else if (Array.isArray(record.tags)) {
    tags = record.tags;
  }

  return {
    id: record.id,
    projectId: record.project_id,
    name: record.name ?? null,
    timestamp: parseTimestamp(record.timestamp),
    environment: record.environment,
    tags: tags,
    bookmarked: Boolean(record.bookmarked),
    release: record.release ?? null,
    version: record.version ?? null,
    userId: record.user_id ?? null,
    sessionId: record.session_id ?? null,
    public: Boolean(record.public),
    input: applyInputOutputRendering(record.input, renderingProps),
    output: applyInputOutputRendering(record.output, renderingProps),
    metadata: parseMetadataCHRecordToDomain(record.metadata),
    createdAt: parseTimestamp(record.created_at),
    updatedAt: parseTimestamp(record.updated_at),
  };
};

export const convertDorisTracesListToDomain = (
  result: Array<TraceRecordReadType & TraceRecordExtraFieldsType>,
  include: { observations: boolean; scores: boolean; metrics: boolean },
): Array<TraceDomain & TraceRecordExtraFieldsType> => {
  return result.map((trace) => {
    return {
      ...convertDorisToDomain(trace, DEFAULT_RENDERING_PROPS),
      // Conditionally include additional fields based on request
      // We need to return empty list on excluded scores / observations
      // and -1 on excluded metrics to not break the SDK API clients
      // that expect those fields if they have not been excluded via 'fields' property
      // See LFE-6361
      observations: include.observations ? trace.observations : [],
      scores: include.scores ? trace.scores : [],
      totalCost: include.metrics ? trace.totalCost : -1,
      latency: include.metrics ? trace.latency : -1,
      htmlPath: trace.htmlPath,
    };
  });
};
