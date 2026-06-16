import type { ApiKey, Prisma, PrismaClient } from "../../db";
import { CloudConfigSchema } from "../../interfaces/cloudConfigSchema";
import { setAppCacheValue, deleteAppCacheKeys } from "../cache/appCache";
import { logger } from "../logger";
import { API_KEY_NON_EXISTENT, OrgEnrichedApiKey } from "./types";
import { getOrganizationPlanServerSide } from "../../features/entitlements/serverPlan";
import { env } from "../../env";

type ApiKeyWithRelations = ApiKey & {
  project: {
    id: string;
    organization: {
      id: string;
      cloudConfig: Prisma.JsonValue;
    };
  } | null;
  organization: {
    id: string;
    cloudConfig: Prisma.JsonValue;
  } | null;
};

const getCacheTtlSeconds = (): number => env.LITEFUSE_CACHE_API_KEY_TTL_SECONDS;

export const getApiKeyCacheKey = (hash: string): string => `api-key:${hash}`;

const getApiKeyOrgContext = (apiKey: ApiKeyWithRelations) => {
  if (apiKey.project?.organization) {
    return {
      orgId: apiKey.project.organization.id,
      cloudConfig: apiKey.project.organization.cloudConfig,
    };
  }

  if (apiKey.organization) {
    return {
      orgId: apiKey.organization.id,
      cloudConfig: apiKey.organization.cloudConfig,
    };
  }

  throw new Error(`No organization found for API key ${apiKey.id}`);
};

export const serializeCachedApiKey = (
  apiKey: ApiKeyWithRelations,
): Prisma.JsonValue => {
  const { orgId, cloudConfig } = getApiKeyOrgContext(apiKey);
  const parsedCloudConfig = CloudConfigSchema.safeParse(cloudConfig);
  const normalizedCloudConfig = parsedCloudConfig.success
    ? parsedCloudConfig.data
    : null;

  return OrgEnrichedApiKey.parse({
    ...apiKey,
    createdAt: apiKey.createdAt?.toISOString(),
    lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    expiresAt: apiKey.expiresAt?.toISOString() ?? null,
    orgId,
    plan: getOrganizationPlanServerSide(normalizedCloudConfig),
    rateLimitOverrides: normalizedCloudConfig?.rateLimitOverrides,
  });
};

export const upsertCachedApiKeysFromDb = async (
  prisma: PrismaClient,
  apiKeys: ApiKey[],
): Promise<void> => {
  const hashKeys = apiKeys
    .map((key) => key.fastHashedSecretKey)
    .filter((hash): hash is string => Boolean(hash));

  if (hashKeys.length === 0) {
    return;
  }

  const hydratedKeys = await prisma.apiKey.findMany({
    where: {
      id: {
        in: apiKeys.map((key) => key.id),
      },
    },
    include: {
      project: {
        include: {
          organization: {
            select: {
              id: true,
              cloudConfig: true,
            },
          },
        },
      },
      organization: {
        select: {
          id: true,
          cloudConfig: true,
        },
      },
    },
  });

  const hydratedByHash = new Map(
    hydratedKeys
      .filter((key) => key.fastHashedSecretKey)
      .map((key) => [key.fastHashedSecretKey as string, key]),
  );

  for (const hash of hashKeys) {
    const hydrated = hydratedByHash.get(hash);
    if (!hydrated) {
      await deleteAppCacheKeys([getApiKeyCacheKey(hash)]);
      continue;
    }

    await setAppCacheValue(
      getApiKeyCacheKey(hash),
      serializeCachedApiKey(hydrated),
      { ttlSeconds: getCacheTtlSeconds() },
    );
  }
};

export const setMissingApiKeyCacheEntry = async (
  prisma: PrismaClient,
  hash: string,
): Promise<void> => {
  await setAppCacheValue(getApiKeyCacheKey(hash), API_KEY_NON_EXISTENT, {
    ttlSeconds: getCacheTtlSeconds(),
  });
};

export const deleteCachedApiKeysByHashes = async (
  hashes: string[],
): Promise<void> => {
  const filteredHashes = hashes.filter(Boolean);
  if (filteredHashes.length === 0) {
    return;
  }

  await deleteAppCacheKeys(filteredHashes.map(getApiKeyCacheKey));
};

export const logApiKeyCacheRefreshError = (
  scope: string,
  error: unknown,
): void => {
  logger.error(`Failed to refresh API key cache for ${scope}`, error);
};
