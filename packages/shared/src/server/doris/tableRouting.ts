import { DorisTableName } from "./schema";
import { splitProjectInCache } from "./tableSplitCache";
import { ensureProjectSplitDesignated } from "./dorisProjectTableSplitControl";

/**
 * Per-project table split routing.
 *
 * THREE functions, each one concern, none named `shard` (that word stays
 * reserved for BullMQ queue sharding):
 *   - isSplitProject(pid): are this project's split tables LIVE?
 *   - tableFor(pid, logical): the PHYSICAL table name to read/write.
 *   - laneFor(pid): the grouping-key (Redis pending lane) a file registers into.
 *
 * Split is universal and deterministic: every project routes to its own
 * `<logical>_<projectId>` tables. The control table still tracks provisioning
 * readiness, but it never decides a fallback to shared telemetry tables.
 */

/**
 * Whether a project's split tables are LIVE — synchronous, cache-backed.
 *
 * Use this only for readiness-sensitive flows such as the grouper deciding
 * whether a lane may be cut. Do not use it to choose a shared table fallback.
 */
export const isSplitProject = (projectId: string): boolean =>
  splitProjectInCache(projectId);

/**
 * Physical table name for a project's logical table.
 *
 * Splittable telemetry tables always resolve to `<logical>_<projectId>`.
 * Shared logical names are not a business read/write fallback anymore.
 */
const SPLITTABLE_TABLES: ReadonlySet<string> = new Set<DorisTableName>([
  "spans",
  "traces_scalar",
]);

const DORIS_PROJECT_ID_RE = /^[A-Za-z0-9_]+$/;

/**
 * Project ids become part of physical Doris identifiers. Restrict them to the
 * identifier-safe alphabet used by generated project ids so no caller can
 * smuggle quoting or SQL through a table suffix.
 */
export const assertValidDorisProjectId = (projectId: string): void => {
  if (!DORIS_PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `Invalid Doris split-table project id: ${JSON.stringify(projectId)}`,
    );
  }
};

export const splitTableNameForProject = (
  projectId: string,
  logical: "spans" | "traces_scalar",
): string => {
  assertValidDorisProjectId(projectId);
  return `${logical}_${projectId}`;
};

export const tableFor = (
  projectId: string,
  logical: DorisTableName,
): string => {
  if (!SPLITTABLE_TABLES.has(logical)) return logical;
  return splitTableNameForProject(
    projectId,
    logical as "spans" | "traces_scalar",
  );
};

/**
 * Physical name of a split project's synchronous MV (mirrors tableFor).
 * The MV is only split when its base table is.
 */
export const metricsAggTableFor = (projectId: string): string => {
  assertValidDorisProjectId(projectId);
  return `trace_metrics_agg_${projectId}`;
};

/**
 * Reverse of tableFor / metricsAggTableFor: map a PHYSICAL table name back to
 * its logical name. `spans_<pid>` → `spans`; an unknown name is
 * returned unchanged. Use this before any lookup keyed on the logical table
 * (metadata-format branch, DATE_FIELD_MAPPINGS, etc.) so split targets resolve
 * through the canonical logical table metadata.
 *
 * The three splittable logicals have no shared prefix, so the `<logical>_`
 * match is unambiguous.
 */
const SPLITTABLE_LOGICALS = [
  "spans",
  "traces_scalar",
  "trace_metrics_agg",
] as const;

export const toLogicalTable = (physical: string): string => {
  for (const logical of SPLITTABLE_LOGICALS) {
    if (physical === logical || physical.startsWith(`${logical}_`)) {
      return logical;
    }
  }
  return physical;
};

/**
 * The grouping-key (Redis pending lane) a project's uploaded file registers
 * into. Every project owns a dedicated lane; there is no shared telemetry shard
 * pool in the all-split model.
 */
export const laneFor = (projectId: string): string => {
  assertValidDorisProjectId(projectId);
  return `lane-${projectId}`;
};

/**
 * Reconcile uses the same deterministic project lane as live ingestion.
 */
export const laneForDesignated = (projectId: string): string =>
  laneFor(projectId);

/**
 * WRITE registration path. Ensure the control row exists, enqueue provisioning
 * if needed, then register the file to the project's lane. Pending lanes are
 * held by the grouper until the tables are live.
 */
export const laneForIngestion = async (projectId: string): Promise<string> => {
  await ensureProjectSplitDesignated(projectId);
  return laneFor(projectId);
};
