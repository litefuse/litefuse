import { type ApiKey } from "../../db";
import { prisma } from "../../db";
import { logger } from "../logger";
import {
  deleteCachedApiKeysByHashes,
  upsertCachedApiKeysFromDb,
} from "./apiKeyCache";

/**
 * Invalidate cached API keys from the shared app cache.
 *
 * Utility used by higher-level helpers to remove individual API keys from the
 * cache, e.g. after key rotation, revocation, or entitlement/plan changes.
 *
 * Note: This only invalidates the cache, not the API keys themselves in the
 * database.
 */
export async function invalidateCachedApiKeys(
  apiKeys: ApiKey[],
  identifier: string,
) {
  const filteredHashKeys = apiKeys
    .map((key) => key.fastHashedSecretKey)
    .filter((hash): hash is string => Boolean(hash));

  if (filteredHashKeys.length === 0) {
    logger.info("No valid keys to invalidate");
    return;
  }

  logger.info(`Refreshing API keys in cache for ${identifier}`);
  await upsertCachedApiKeysFromDb(prisma, apiKeys);
}

/**
 * Invalidate all cached API keys for an organization from cache.
 *
 * This function is used when organization-level changes occur that affect API
 * key validity, such as plan changes, usage threshold changes, or billing
 * cycle updates.
 */
export async function invalidateCachedOrgApiKeys(orgId: string): Promise<void> {
  const apiKeys = await prisma.apiKey.findMany({
    where: {
      OR: [
        {
          project: {
            orgId,
          },
        },
        { orgId },
      ],
    },
  });

  const hashKeys = apiKeys
    .map((key) => key.fastHashedSecretKey)
    .filter((hash): hash is string => Boolean(hash));

  if (hashKeys.length === 0) {
    logger.info(`No valid API keys to invalidate for org ${orgId}`);
    return;
  }

  logger.info(`Refreshing API keys in cache for org ${orgId}`);
  await upsertCachedApiKeysFromDb(prisma, apiKeys);
}

/**
 * Invalidate all cached API keys for a project from cache.
 *
 * This function is used when project-level changes occur that affect API key
 * validity.
 */
export async function invalidateCachedProjectApiKeys(
  projectId: string,
): Promise<void> {
  const apiKeys = await prisma.apiKey.findMany({
    where: {
      projectId,
      scope: "PROJECT",
    },
  });

  const hashKeys = apiKeys
    .map((key) => key.fastHashedSecretKey)
    .filter((hash): hash is string => Boolean(hash));

  if (hashKeys.length === 0) {
    logger.info(`No valid API keys to invalidate for project ${projectId}`);
    return;
  }

  logger.info(`Refreshing API keys in cache for project ${projectId}`);
  await upsertCachedApiKeysFromDb(prisma, apiKeys);
}

export async function deleteCachedApiKeys(
  apiKeys: ApiKey[],
  identifier: string,
): Promise<void> {
  const filteredHashKeys = apiKeys
    .map((key) => key.fastHashedSecretKey)
    .filter((hash): hash is string => Boolean(hash));

  if (filteredHashKeys.length === 0) {
    logger.info("No valid keys to delete from cache");
    return;
  }

  logger.info(`Deleting API keys in cache for ${identifier}`);
  await deleteCachedApiKeysByHashes(filteredHashKeys);
}
