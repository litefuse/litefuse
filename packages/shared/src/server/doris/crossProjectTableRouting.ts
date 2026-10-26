import { logger } from "../logger";
import { recordHistogram, recordIncrement } from "../instrumentation";
import { splitTableNameForProject } from "./tableRouting";

export type CrossProjectDorisLogicalTable = "spans" | "traces_scalar";

export type DorisProjectTableTarget = {
  logicalTable: CrossProjectDorisLogicalTable;
  physicalTable: string;
  projectIds: string[];
  split: true;
};

export const DEFAULT_DORIS_PROJECT_FANOUT_CONCURRENCY = 8;

const mapWithConcurrency = async <TInput, TOutput>(params: {
  items: TInput[];
  concurrency: number;
  mapper: (item: TInput) => Promise<TOutput>;
}): Promise<TOutput[]> => {
  const results = new Array<TOutput>(params.items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < params.items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await params.mapper(params.items[currentIndex]);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(params.concurrency, params.items.length) },
      () => worker(),
    ),
  );
  return results;
};

/** Resolve one split physical target per project. */
export const resolveDorisProjectTableTargets = async (params: {
  logicalTable: CrossProjectDorisLogicalTable;
  projectIds: string[];
}): Promise<DorisProjectTableTarget[]> => {
  const projectIds = Array.from(new Set(params.projectIds));
  if (projectIds.length === 0) return [];

  return projectIds.map((projectId) => ({
    logicalTable: params.logicalTable,
    physicalTable: splitTableNameForProject(projectId, params.logicalTable),
    projectIds: [projectId],
    split: true,
  }));
};

export const isMissingSplitTableReadError = (e: unknown): boolean => {
  const message = e instanceof Error ? e.message : String(e);
  return /does not exist|unknown table|table.*not found|TableNotFound/i.test(
    message,
  );
};

export const logMissingReadTarget = (
  logicalTable: CrossProjectDorisLogicalTable,
  physicalTable: string,
): void => {
  recordIncrement("langfuse.doris.split_table.read_missing", 1, {
    logicalTable,
  });
  logger.warn("Doris split-table read target missing; returning empty result", {
    logicalTable,
    physicalTable,
  });
};

/** Execute a cross-project Doris query with bounded target concurrency. */
export const executeDorisProjectFanout = async <T>(params: {
  logicalTable: CrossProjectDorisLogicalTable;
  projectIds: string[];
  queryTarget: (target: DorisProjectTableTarget) => Promise<T[]>;
  concurrency?: number;
}): Promise<T[]> => {
  const startedAt = Date.now();
  const targets = await resolveDorisProjectTableTargets(params);
  if (targets.length === 0) return [];
  const concurrency = Math.max(
    1,
    params.concurrency ?? DEFAULT_DORIS_PROJECT_FANOUT_CONCURRENCY,
  );
  const rows = (
    await mapWithConcurrency({
      items: targets,
      concurrency,
      mapper: async (target) => {
        try {
          return await params.queryTarget(target);
        } catch (e) {
          if (isMissingSplitTableReadError(e)) {
            logMissingReadTarget(params.logicalTable, target.physicalTable);
            return [];
          }
          throw e;
        }
      },
    })
  ).flat();

  const durationMs = Date.now() - startedAt;
  recordHistogram("langfuse.doris.project_fanout.duration_ms", durationMs, {
    logicalTable: params.logicalTable,
    targetCount: targets.length,
  });
  logger.debug("Executed cross-project Doris fan-out", {
    logicalTable: params.logicalTable,
    projectCount: new Set(params.projectIds).size,
    targetCount: targets.length,
    durationMs,
  });
  return rows;
};

/**
 * Query targets with bounded concurrency and stop assigning new targets after
 * one returns a match. Already-running queries are allowed to finish.
 */
export const findFirstDorisProjectTarget = async <T>(params: {
  logicalTable: CrossProjectDorisLogicalTable;
  projectIds: string[];
  queryTarget: (target: DorisProjectTableTarget) => Promise<T[]>;
  concurrency?: number;
}): Promise<T[]> => {
  const targets = await resolveDorisProjectTableTargets(params);
  if (targets.length === 0) return [];

  const concurrency = Math.max(
    1,
    params.concurrency ?? DEFAULT_DORIS_PROJECT_FANOUT_CONCURRENCY,
  );
  let nextIndex = 0;
  let match: T[] = [];

  const worker = async (): Promise<void> => {
    while (match.length === 0 && nextIndex < targets.length) {
      const target = targets[nextIndex++];
      let rows: T[];
      try {
        rows = await params.queryTarget(target);
      } catch (e) {
        if (isMissingSplitTableReadError(e)) {
          logMissingReadTarget(params.logicalTable, target.physicalTable);
          rows = [];
        } else {
          throw e;
        }
      }
      if (rows.length > 0 && match.length === 0) match = rows;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () =>
      worker(),
    ),
  );
  return match;
};
