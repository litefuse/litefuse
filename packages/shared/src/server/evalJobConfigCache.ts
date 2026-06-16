import { logger } from "./logger";
import {
  deleteAppCacheKey,
  getAppCacheValue,
  setAppCacheValue,
} from "./cache/appCache";

/**
 * App-cache utilities for eval job configuration optimization.
 *
 * This module reduces database calls when checking for job configurations. When
 * a project has no executable evaluation job configurations, we cache this fact
 * in the single-node in-memory app cache to avoid unnecessary database queries
 * and queue processing.
 */

/** Cache types for different eval job configuration targets */
type EvalConfigCacheType = "traceBased" | "eventBased";

const CACHE_PREFIXES: Record<EvalConfigCacheType, string> = {
  traceBased: "langfuse:eval:no-trace-and-dataset-job-configs", // for target_object 'trace' | 'observation'
  eventBased: "langfuse:eval:no-event-and-experiment-job-configs", // for target_object 'event' | 'experiment'
};

const CACHE_TTL_SECONDS = 600; // 10 minutes

/**
 * Check if a project has no eval configurations cached.
 * Returns true if the cache indicates no configs exist.
 */
export const hasNoEvalConfigsCache = async (
  projectId: string,
  cacheType: EvalConfigCacheType,
): Promise<boolean> => {
  try {
    const cacheKey = `${CACHE_PREFIXES[cacheType]}:${projectId}`;
    const cached = await getAppCacheValue<string>(cacheKey);

    return Boolean(cached);
  } catch (error) {
    logger.error(`Failed to check no ${cacheType} eval configs cache`, error);

    return false;
  }
};

/**
 * Cache that a project has no executable eval configurations.
 * The cache expires after 10 minutes to ensure eventual consistency.
 */
export const setNoEvalConfigsCache = async (
  projectId: string,
  cacheType: EvalConfigCacheType,
): Promise<void> => {
  try {
    const cacheKey = `${CACHE_PREFIXES[cacheType]}:${projectId}`;
    await setAppCacheValue(cacheKey, "1", { ttlSeconds: CACHE_TTL_SECONDS });
    logger.debug(
      `Cached no ${cacheType} eval configs for project ${projectId}`,
    );
  } catch (error) {
    logger.error(`Failed to cache no ${cacheType} eval configs status`, error);
  }
};

/**
 * Clear the "no eval configs" cache for a project.
 * Should be called when job configurations become executable again.
 */
export const clearNoEvalConfigsCache = async (
  projectId: string,
  cacheType: EvalConfigCacheType,
): Promise<void> => {
  try {
    const cacheKey = `${CACHE_PREFIXES[cacheType]}:${projectId}`;
    await deleteAppCacheKey(cacheKey);
    logger.debug(
      `Cleared no ${cacheType} eval configs cache for project ${projectId}`,
    );
  } catch (error) {
    logger.error(`Failed to clear no ${cacheType} eval configs cache`, error);
  }
};

export const invalidateProjectEvalConfigCaches = (
  projectId: string,
): Promise<[void, void]> =>
  Promise.all([
    clearNoEvalConfigsCache(projectId, "traceBased"),
    clearNoEvalConfigsCache(projectId, "eventBased"),
  ]);
