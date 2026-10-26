import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Per-project Doris table DDL generation (Stage 1.2).
 *
 * A split project gets its own `spans_<pid>` / `traces_scalar_<pid>` base
 * tables + a `trace_metrics_agg_<pid>` sync MV. There is no shared telemetry
 * table (all-split model): a split table holds ONE project, so project_id is
 * constant and dropped from the KEY (spans KEY = (trace_id, span_id);
 * traces_scalar KEY = (id, start_time)). They use dynamic_partition instead of
 * AUTO PARTITION so old day-partitions are auto-dropped at the project's
 * retention (the whole point of the split).
 *
 * SOURCE OF TRUTH = the template files under `doris/migrations` WITHOUT a
 * .up.sql suffix (scripts/up.sh globs *.up.sql, so it never applies them):
 *   - `0037_spans.sql` / `0039_traces_scalar.sql` — column+index+KEY body
 *     with a __TABLE__ placeholder; the partition/dist/PROPERTIES tail is
 *     appended at build time (buildDynamicPartitionTail).
 *   - `0040_trace_metrics_agg.sql` — the sync MV, __TABLE__ (name) + __BASE_TABLE__
 *     (aggregated base). Keep in sync with the read-side rewrite
 *     (dataModelDoris.traceMetricsAggRelationSql).
 * These are the ONLY schema source — there is no separate shared CREATE
 * migration to drift from.
 */

/** Bump when the generated tail/MV shape changes; recorded in the schema-version gate. */
export const SPLIT_SCHEMA_VERSION = 4;

/** Future day-partitions dynamic_partition pre-creates (clock-skew buffer). */
const DYNAMIC_PARTITION_END = 3;

/**
 * "No TTL" (retentionDays null): a 10-year drop threshold ≈ never drops.
 * dynamic_partition is present from creation (alongside AUTO PARTITION), so
 * TTL is retrofittable at any time via ALTER dynamic_partition.start
 * (buildAlterTtlStatement) and its scheduler drops the auto-created partitions.
 */
export const NO_TTL_START_DAYS = 3650;

/** Split-table DDL template (column+index+KEY body with a __TABLE__ placeholder,
 * split key/order) per logical table — the SINGLE source the per-project CREATE
 * is built from. Lives in doris/migrations WITHOUT a .up.sql suffix, so
 * scripts/up.sh never applies it (it globs *.up.sql): there is no shared table. */
const SPLIT_TEMPLATE_FILE: Record<string, string> = {
  spans: "0037_spans.sql",
  traces_scalar: "0039_traces_scalar.sql",
};

/** The trace_metrics_agg sync-MV template (same migrations dir, no .up.sql). */
const MV_TEMPLATE_FILE = "0040_trace_metrics_agg.sql";

/** Placeholder in the templates, replaced with the per-project table name. */
const SPLIT_TABLE_PLACEHOLDER = "__TABLE__";

/** MV-only placeholder for the aggregated base table (spans_<pid>). */
const MV_BASE_TABLE_PLACEHOLDER = "__BASE_TABLE__";

/** Distribution column + storage model per shared logical table (stable). */
export const SPLIT_BASE_TABLE_SHAPES = {
  spans: { distributionColumn: "trace_id", mergeOnWrite: false },
  traces_scalar: { distributionColumn: "id", mergeOnWrite: true },
} as const;

export type SplitTailOpts = {
  /** Distribution (bucket) column — trace_id for spans, id for traces_scalar. */
  distributionColumn: string;
  /** UNIQUE KEY + Merge-on-Write table (traces_scalar) vs DUPLICATE (spans). */
  mergeOnWrite: boolean;
  /** Days of data to keep (dynamic_partition.start = -retentionDays); null/undefined
   * = no TTL (a 10-year threshold ≈ never drops). Set/changed later via
   * buildAlterTtlStatement. */
  retentionDays?: number | null;
  /** Replication factor (tag.location.default). */
  replication: number;
  /** Optional storage page size, in bytes. Only spans supplies this. */
  storagePageSize?: number;
};

/** dynamic_partition.start magnitude (days) for a given retention. AUTO
 * PARTITION creates in-retention days on write, so no history pre-creation is
 * needed — only the drop threshold matters. */
const startDaysFor = (retentionDays: number | null | undefined): number =>
  retentionDays ?? NO_TTL_START_DAYS;

/**
 * The partition/distribution/properties tail appended to each split table.
 *
 * AUTO PARTITION (by day) + dynamic_partition together (verified on Doris 4.0.6):
 *   - AUTO PARTITION creates a day partition ON WRITE for whatever start_time
 *     arrives — including back-dated/late telemetry — so there is NO need to
 *     pre-materialize history partitions (no create_history_partition /
 *     history_partition_num, which previously had to span the whole retention
 *     window and made provisioning heavy).
 *   - dynamic_partition (from creation) still owns TTL: its scheduler DROPS any
 *     partition older than `start` days, auto-created ones included, so retention
 *     works and is retrofittable via ALTER dynamic_partition.start
 *     (buildAlterTtlStatement). `end` pre-creates a few near-future days as a
 *     clock-skew buffer so the current day's first write isn't blocked on an
 *     auto-create.
 *
 * Bucketing is DELEGATED to Doris: emit `DISTRIBUTED BY HASH(col) BUCKETS AUTO`
 * and set NO dynamic_partition.buckets — no magic number in our DDL. The
 * cluster's `autobucket_min_buckets` FE config floors the count (a fresh
 * auto-partition day starts empty, so Auto Bucket would otherwise land at 1);
 * we let Doris own the sizing rather than pin a number.
 */
export const buildDynamicPartitionTail = (opts: SplitTailOpts): string => {
  const startDays = startDaysFor(opts.retentionDays);
  const props: Array<[string, string]> = [
    ["replication_allocation", `tag.location.default: ${opts.replication}`],
    ...(opts.storagePageSize !== undefined
      ? ([["storage_page_size", String(opts.storagePageSize)]] as [
          string,
          string,
        ][])
      : []),
    ...(opts.mergeOnWrite
      ? ([["enable_unique_key_merge_on_write", "true"]] as [string, string][])
      : []),
    ["dynamic_partition.enable", "true"],
    ["dynamic_partition.time_unit", "DAY"],
    ["dynamic_partition.time_zone", "Etc/UTC"],
    ["dynamic_partition.start", `-${startDays}`],
    ["dynamic_partition.end", String(DYNAMIC_PARTITION_END)],
    ["dynamic_partition.prefix", "p"],
  ];
  const propsSql = props.map(([k, v]) => `    "${k}" = "${v}"`).join(",\n");
  return [
    `AUTO PARTITION BY RANGE (date_trunc(\`start_time\`, 'day')) ()`,
    `DISTRIBUTED BY HASH(\`${opts.distributionColumn}\`) BUCKETS AUTO`,
    `PROPERTIES (`,
    propsSql,
    `)`,
  ].join("\n");
};

/**
 * ALTER to set or change a split table's TTL (retention). retentionDays null =
 * remove TTL (back to the 10-year no-drop threshold). The drop of now-expired
 * partitions happens on the dynamic_partition scheduler's next tick
 * (dynamic_partition_check_interval_seconds), not synchronously.
 */
export const buildAlterTtlStatement = (params: {
  physicalTable: string;
  retentionDays?: number | null;
}): string => {
  const startDays = startDaysFor(params.retentionDays);
  return (
    `ALTER TABLE \`${params.physicalTable}\` SET (` +
    `"dynamic_partition.start" = "-${startDays}")`
  );
};

/**
 * Build a per-project CREATE from the split template: take the split column +
 * index + KEY body (already in split key/order, __TABLE__ placeholder), swap in
 * the physical table name, and append buildDynamicPartitionTail(opts).
 *
 * @param templateSql   the split template `CREATE TABLE IF NOT EXISTS __TABLE__ (...) ... KEY(...)`
 * @param sharedTable   the shared logical table name it describes (e.g. spans)
 * @param physicalTable the target per-project name (e.g. spans_<pid>)
 */
export const buildSplitTableFromTemplate = (params: {
  templateSql: string;
  sharedTable: string;
  physicalTable: string;
  tail: SplitTailOpts;
}): string => {
  const { templateSql, sharedTable, physicalTable, tail } = params;
  if (!templateSql.includes(SPLIT_TABLE_PLACEHOLDER)) {
    throw new Error(
      `buildSplitTableFromTemplate: split template for ${sharedTable} has no ${SPLIT_TABLE_PLACEHOLDER} placeholder`,
    );
  }
  // Drop the leading comment banner — start the statement at CREATE TABLE. The
  // template ends at the KEY line (no partition tail, no trailing ';'), so the
  // rest of the file is the CREATE head verbatim.
  const createStart = templateSql.search(/CREATE TABLE/i);
  if (createStart < 0) {
    throw new Error(
      `buildSplitTableFromTemplate: no CREATE TABLE found in split template for ${sharedTable}`,
    );
  }
  const head = templateSql
    .slice(createStart)
    .split(SPLIT_TABLE_PLACEHOLDER)
    .join(`\`${physicalTable}\``);
  return `${head.trim()}\n${buildDynamicPartitionTail(tail)}`;
};

/**
 * The per-project trace_metrics_agg sync MV, built from the 0040 template file
 * (coupled to dataModelDoris.traceMetricsAggRelationSql — the read-side rewrite
 * shape must match for the transparent rewrite to fire). Only the MV name and
 * base table are per-project; the aggregate shape is identical.
 */
export const buildTraceMetricsAggMV = (params: {
  mvName: string;
  baseTable: string;
}): string => {
  const template = readFileSync(
    join(resolveMigrationsDir(), MV_TEMPLATE_FILE),
    "utf8",
  );
  const start = template.search(/CREATE MATERIALIZED VIEW/i);
  if (start < 0) {
    throw new Error(
      `buildTraceMetricsAggMV: no CREATE MATERIALIZED VIEW in ${MV_TEMPLATE_FILE}`,
    );
  }
  return template
    .slice(start)
    .split(SPLIT_TABLE_PLACEHOLDER)
    .join(params.mvName)
    .split(MV_BASE_TABLE_PLACEHOLDER)
    .join(params.baseTable)
    .trim();
};

/** Every ancestor of `from`, nearest first, including `from` itself. */
const ancestorsOf = (from: string): string[] => {
  const out: string[] = [];
  let dir = from;
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
};

let resolvedMigrationsDir: string | undefined;

/**
 * Locate the shared package's doris/migrations dir. The dir ships in both
 * images as packages/shared/doris, but this module is loaded from different
 * places: shared/dist (worker, scripts), shared/src (vitest), or BUNDLED into
 * web/.next/server/chunks by Next.js — where a fixed number of `..` from
 * __dirname lands nowhere near it. So walk UP from __dirname and from
 * process.cwd() and take the first ancestor that contains
 * `packages/shared/doris/migrations` (repo / image layout) or
 * `doris/migrations` (an ancestor that IS the shared package). Memoised —
 * the layout cannot change while the process runs.
 */
export const resolveMigrationsDir = (): string => {
  if (resolvedMigrationsDir) return resolvedMigrationsDir;
  const roots = [__dirname, process.cwd()];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const ancestor of ancestorsOf(root)) {
      candidates.push(
        join(ancestor, "packages/shared/doris/migrations"),
        join(ancestor, "doris/migrations"),
      );
    }
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, "0037_spans.sql"))) {
      resolvedMigrationsDir = dir;
      return dir;
    }
  }
  throw new Error(
    `resolveMigrationsDir: doris/migrations not found walking up from ${roots.join(" and ")}`,
  );
};

/** Read a split-table DDL template (with __TABLE__ placeholder) for a table.
 * Templates live in doris/migrations without a .up.sql suffix (up.sh ignores
 * them); they are the single source — there is no shared table to drift from. */
export const readSplitTemplate = (sharedTable: string): string => {
  const file = SPLIT_TEMPLATE_FILE[sharedTable];
  if (!file) {
    throw new Error(`readSplitTemplate: unknown shared table ${sharedTable}`);
  }
  return readFileSync(join(resolveMigrationsDir(), file), "utf8");
};

/**
 * All DDL statements to provision a split project, in apply order:
 * spans_<pid>, traces_scalar_<pid>, then the MV on spans_<pid>.
 * Base-table DDL is our split template (split key/order) with a
 * dynamic_partition tail.
 */
export const buildSplitTableStatements = (params: {
  projectId: string;
  /** null/undefined = provision with no TTL; set later via buildAlterTtlStatement. */
  retentionDays?: number | null;
  replication: number;
  /** spans storage page size, in bytes. */
  storagePageSize: number;
}): { spans: string; tracesScalar: string; mv: string } => {
  const { projectId, retentionDays, replication, storagePageSize } = params;
  const tailBase = { retentionDays, replication };
  const spans = buildSplitTableFromTemplate({
    templateSql: readSplitTemplate("spans"),
    sharedTable: "spans",
    physicalTable: `spans_${projectId}`,
    tail: {
      ...SPLIT_BASE_TABLE_SHAPES.spans,
      ...tailBase,
      storagePageSize,
    },
  });
  const tracesScalar = buildSplitTableFromTemplate({
    templateSql: readSplitTemplate("traces_scalar"),
    sharedTable: "traces_scalar",
    physicalTable: `traces_scalar_${projectId}`,
    tail: { ...SPLIT_BASE_TABLE_SHAPES.traces_scalar, ...tailBase },
  });
  const mv = buildTraceMetricsAggMV({
    mvName: `trace_metrics_agg_${projectId}`,
    baseTable: `spans_${projectId}`,
  });
  return { spans, tracesScalar, mv };
};
