export default async function teardown() {
  const { redis, logger } = await import("@langfuse/shared/src/server");

  // Always clear globalThis references so subsequent test suites in --runInBand
  // never inherit a disconnected Redis client even if a test closed it early.
  (globalThis as { redis?: unknown }).redis = undefined;
  (
    globalThis as { litefuseUnprefixedRedis?: unknown }
  ).litefuseUnprefixedRedis = undefined;

  logger.debug(`Redis status ${redis?.status}`);
  if (!redis) {
    return;
  }
  if (redis.status === "end" || redis.status === "close") {
    logger.debug("Redis connection already closed");
    return;
  }
  redis?.disconnect();
  logger.debug("Teardown complete");
}
