import { env } from "../env";
import {
  hasAppCacheKey,
  logger,
  recordIncrement,
  setAppCacheValue,
  traceException,
} from "./";

const TTL_SECONDS = 86400; // 24 hours

/**
 * Marks a project as using OTEL API ingestion in Redis with a 24-hour TTL.
 * Only performs the operation if LITEFUSE_SKIP_FINAL_FOR_OTEL_PROJECTS is enabled.
 */
export async function markProjectAsOtelUser(projectId: string): Promise<void> {
  // Check if feature is enabled
  if (env.LITEFUSE_SKIP_FINAL_FOR_OTEL_PROJECTS !== "true") {
    return;
  }

  try {
    const key = `langfuse:project:${projectId}:otel:active`;
    await setAppCacheValue(key, "1", { ttlSeconds: TTL_SECONDS });
    recordIncrement("langfuse.otel_tracking.marked", 1);
  } catch (error) {
    traceException(error);
    logger.error("Failed to mark project as OTEL user", { projectId, error });
  }
}

/**
 * Checks if a project is currently marked as using OTEL API ingestion.
 * Returns false if feature is disabled or if the cache key doesn't exist.
 */
export async function isProjectOtelUser(projectId: string): Promise<boolean> {
  // If feature is disabled, always return false
  if (env.LITEFUSE_SKIP_FINAL_FOR_OTEL_PROJECTS !== "true") {
    return false;
  }

  try {
    const key = `langfuse:project:${projectId}:otel:active`;
    return hasAppCacheKey(key);
  } catch (error) {
    traceException(error);
    logger.error("Failed to check if project is OTEL user", {
      projectId,
      error,
    });
    return false;
  }
}
