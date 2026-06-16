import { env } from "@/src/env.mjs";
import {
  createShaHash,
  recordIncrement,
  verifySecretKey,
  type AuthHeaderVerificationResult,
  CachedApiKey,
  deleteCachedApiKeys,
  deleteAppCacheKey,
  getAppCacheValue,
  OrgEnrichedApiKey,
  logger,
  instrumentAsync,
  addUserToSpan,
  invalidateCachedApiKeys as invalidateCachedApiKeysShared,
  invalidateCachedOrgApiKeys as invalidateCachedOrgApiKeysShared,
  invalidateCachedProjectApiKeys as invalidateCachedProjectApiKeysShared,
  API_KEY_NON_EXISTENT,
  setMissingApiKeyCacheEntry,
  setAppCacheValue,
} from "@langfuse/shared/src/server";
import {
  type PrismaClient,
  type ApiKey,
  type Prisma,
  type ApiKeyScope,
} from "@langfuse/shared/src/db";
import { isPrismaException } from "@/src/utils/exceptions";
import { getOrganizationPlanServerSide } from "@/src/features/entitlements/server/getPlan";
import { type z } from "zod/v4";
import { CloudConfigSchema, isPlan } from "@langfuse/shared";

export class ApiAuthService {
  constructor(private prisma: PrismaClient) {}

  // this function needs to be called, when the organisation is updated
  // - when projects move across organisations, the orgId in the API key cache needs to be updated
  // - when the plan of the org changes, the plan in the API key cache needs to be updated as well
  async refreshCachedApiKeys(apiKeys: ApiKey[], identifier: string) {
    await invalidateCachedApiKeysShared(apiKeys, identifier);
  }

  async deleteCachedApiKeys(apiKeys: ApiKey[], identifier: string) {
    await deleteCachedApiKeys(apiKeys, identifier);
  }

  async refreshCachedOrgApiKeys(orgId: string) {
    await invalidateCachedOrgApiKeysShared(orgId);
  }

  async refreshCachedProjectApiKeys(projectId: string) {
    await invalidateCachedProjectApiKeysShared(projectId);
  }

  /**
   * Deletes an API key from the database and invalidates it in cache.
   * @param id - The ID of the API key to delete.
   * @param entityId - The ID of the entity (project or organization) to which the API key belongs.
   * @param scope - The scope of the API key (either "PROJECT" or "ORGANIZATION").
   */
  async deleteApiKey(id: string, entityId: string, scope: ApiKeyScope) {
    const entity =
      scope === "PROJECT" ? { projectId: entityId } : { orgId: entityId };
    // Make sure the API key exists and belongs to the project the user has access to
    const apiKey = await this.prisma.apiKey.findFirstOrThrow({
      where: {
        ...entity,
        id: id,
        scope,
      },
    });
    if (!apiKey) {
      return false;
    }

    await this.deleteCachedApiKeys([apiKey], `key ${id}`);

    await this.prisma.apiKey.delete({
      where: {
        id: apiKey.id,
      },
    });
    return true;
  }

  async verifyAuthHeaderAndReturnScope(
    authHeader: string | undefined,
  ): Promise<AuthHeaderVerificationResult> {
    const result: AuthHeaderVerificationResult = await instrumentAsync(
      { name: "api-auth-verify" },
      async () => {
        if (!authHeader) {
          logger.debug("No authorization header");
          return {
            validKey: false,
            error: "No authorization header",
          };
        }

        try {
          // Basic auth, full scope, needs secret key and public key
          if (authHeader.startsWith("Basic ")) {
            const { username: publicKey, password: secretKey } =
              this.extractBasicAuthCredentials(authHeader);

            const salt = env.SALT;
            const hashFromProvidedKey = createShaHash(secretKey, salt);

            const apiKey =
              await this.fetchApiKeyAndAddToCache(hashFromProvidedKey);

            let finalApiKey = apiKey;

            if (!apiKey || !apiKey.fastHashedSecretKey) {
              const slowKey = await this.prisma.apiKey.findUnique({
                where: { publicKey },
                include: {
                  project: { include: { organization: true } },
                  organization: true,
                },
              });

              if (!slowKey) {
                logger.error("No key found for public key", publicKey);
                logger.info(
                  `No key found, storing ${API_KEY_NON_EXISTENT} in cache`,
                );
                await setMissingApiKeyCacheEntry(
                  this.prisma,
                  hashFromProvidedKey,
                );
                throw new Error("Invalid credentials");
              }

              const isValid = await verifySecretKey(
                secretKey,
                slowKey.hashedSecretKey,
              );

              if (!isValid) {
                logger.debug(`Old key is invalid: ${publicKey}`);
                throw new Error("Invalid credentials");
              }

              const shaKey = createShaHash(secretKey, salt);

              await this.prisma.apiKey.update({
                where: { publicKey },
                data: {
                  fastHashedSecretKey: shaKey,
                },
              });
              finalApiKey = this.convertToCachedRepresentation({
                ...slowKey,
                fastHashedSecretKey: shaKey,
              });
            }

            if (!finalApiKey) {
              logger.info("No project id found for key", publicKey);
              throw new Error("Invalid credentials");
            }

            const plan = finalApiKey.plan;

            if (!isPlan(plan)) {
              logger.error("Invalid plan type for key", finalApiKey.plan);
              throw new Error("Invalid credentials");
            }

            addUserToSpan({
              projectId: finalApiKey.projectId ?? undefined,
              orgId: finalApiKey.orgId,
              plan,
            });

            const accessLevel =
              finalApiKey.scope === "ORGANIZATION" ? "organization" : "project";

            return {
              validKey: true,
              scope: {
                projectId: finalApiKey.projectId,
                accessLevel,
                orgId: finalApiKey.orgId,
                plan: plan,
                rateLimitOverrides: finalApiKey.rateLimitOverrides ?? [],
                apiKeyId: finalApiKey.id,
                scope: finalApiKey.scope,
                publicKey,
              },
            };
          }
          // Bearer auth, limited scope, only needs public key
          if (authHeader.startsWith("Bearer ")) {
            const publicKey = authHeader.replace("Bearer ", "");

            const dbKey = await this.findDbKeyOrThrow(publicKey);

            if (dbKey.scope === "ORGANIZATION") {
              throw new Error(
                "Unauthorized: Cannot use organization key with bearer auth",
              );
            }

            const { orgId, cloudConfig } =
              this.extractOrgIdAndCloudConfig(dbKey);

            addUserToSpan({
              projectId: dbKey.projectId ?? undefined,
              orgId,
              plan: getOrganizationPlanServerSide(cloudConfig),
            });

            return {
              validKey: true,
              scope: {
                projectId: dbKey.projectId,
                accessLevel: "scores",
                orgId,
                plan: getOrganizationPlanServerSide(cloudConfig),
                rateLimitOverrides: cloudConfig?.rateLimitOverrides ?? [],
                apiKeyId: dbKey.id,
                scope: dbKey.scope,
                publicKey,
              },
            };
          }
        } catch (error: unknown) {
          logger.info(
            `Error verifying auth header: ${error instanceof Error ? error.message : null}`,
            error,
          );

          if (isPrismaException(error)) {
            throw error;
          }

          return {
            validKey: false,
            error:
              (error instanceof Error ? error.message : "Authorization error") +
              ". Confirm that you've configured the correct host.",
          };
        }
        return {
          validKey: false,
          error: "Invalid authorization header",
        };
      },
    );

    return result;
  }

  private extractBasicAuthCredentials(basicAuthHeader: string): {
    username: string;
    password: string;
  } {
    const authValue = basicAuthHeader.split(" ")[1];
    if (!authValue) throw new Error("Invalid authorization header");

    const [username, password] = atob(authValue).split(":");
    if (!username || !password) throw new Error("Invalid authorization header");
    return { username, password };
  }

  private async findDbKeyOrThrow(publicKey: string) {
    const dbKey = await this.prisma.apiKey.findUnique({
      where: { publicKey },
      include: {
        project: { include: { organization: true } },
        organization: true,
      },
    });
    if (!dbKey) {
      logger.info("No api key found for public key:", publicKey);
      throw new Error("Invalid public key");
    }
    return dbKey;
  }

  private async fetchApiKeyAndAddToCache(hash: string) {
    const cachedApiKey = await this.fetchApiKeyFromCache(hash);

    if (cachedApiKey === API_KEY_NON_EXISTENT) {
      recordIncrement("langfuse.api_key.cache_hit", 1);
      throw new Error("Invalid credentials");
    }

    if (cachedApiKey) {
      recordIncrement("langfuse.api_key.cache_hit", 1);
      return cachedApiKey;
    }

    recordIncrement("langfuse.api_key.cache_miss", 1);

    const apiKeyAndOrganisation = await this.prisma.apiKey.findUnique({
      where: { fastHashedSecretKey: hash },
      include: {
        project: { include: { organization: true } },
        organization: true,
      },
    });

    if (apiKeyAndOrganisation && apiKeyAndOrganisation.fastHashedSecretKey) {
      await this.addApiKeyToCache(
        hash,
        this.convertToCachedRepresentation(apiKeyAndOrganisation),
      );
    }
    return apiKeyAndOrganisation
      ? this.convertToCachedRepresentation(apiKeyAndOrganisation)
      : null;
  }

  private async addApiKeyToCache(
    hash: string,
    newApiKey: z.infer<typeof OrgEnrichedApiKey> | typeof API_KEY_NON_EXISTENT,
  ) {
    if (env.LITEFUSE_CACHE_API_KEY_ENABLED !== "true") {
      return;
    }

    try {
      await setAppCacheValue(this.createCacheKey(hash), newApiKey, {
        ttlSeconds: env.LITEFUSE_CACHE_API_KEY_TTL_SECONDS,
      });
    } catch (error: unknown) {
      logger.error("Error adding key to cache", error);
    }
  }

  private async fetchApiKeyFromCache(hash: string) {
    if (env.LITEFUSE_CACHE_API_KEY_ENABLED !== "true") {
      return null;
    }

    try {
      const cachedApiKey = await getAppCacheValue<unknown>(
        this.createCacheKey(hash),
        { touchTtlSeconds: env.LITEFUSE_CACHE_API_KEY_TTL_SECONDS },
      );

      if (!cachedApiKey) {
        return null;
      }

      const parsedApiKey = CachedApiKey.safeParse(cachedApiKey);

      if (parsedApiKey.success) {
        return parsedApiKey.data;
      }

      logger.error(
        "Failed to parse API key from cache, deleting existing key",
        parsedApiKey.error,
      );
      await deleteAppCacheKey(this.createCacheKey(hash));
      return null;
    } catch (error: unknown) {
      logger.error("Error fetching key from cache", error);
      return null;
    }
  }

  private createCacheKey(hash: string) {
    return `api-key:${hash}`;
  }

  private extractOrgIdAndCloudConfig(
    apiKeyAndOrganisation: ApiKey & {
      project: {
        id: string;
        organization: {
          id: string;
          name: string;
          createdAt: Date;
          updatedAt: Date;
          cloudConfig: Prisma.JsonValue;
        };
      } | null;
    } & {
      organization: {
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        cloudConfig: Prisma.JsonValue;
      } | null;
    },
  ) {
    const orgId =
      apiKeyAndOrganisation.project?.organization.id ??
      apiKeyAndOrganisation.organization?.id;
    const rawCloudConfig =
      apiKeyAndOrganisation.project?.organization.cloudConfig ??
      apiKeyAndOrganisation.organization?.cloudConfig;
    if (!orgId) {
      logger.error(
        `No organization found for key: ${apiKeyAndOrganisation.publicKey}`,
      );
      throw new Error("Invalid credentials: No organization found for key");
    }

    const cloudConfig = rawCloudConfig
      ? CloudConfigSchema.parse(rawCloudConfig)
      : undefined;

    return {
      orgId,
      cloudConfig,
    };
  }

  /**
   * Converts the API key and organization to a cache representation.
   * For project-scoped API keys, it includes the project ID and organization.
   * For organization-scoped API keys, it includes only the organization.
   * @param apiKeyAndOrganisation
   */
  private convertToCachedRepresentation(
    apiKeyAndOrganisation: ApiKey & {
      project: {
        id: string;
        organization: {
          id: string;
          name: string;
          createdAt: Date;
          updatedAt: Date;
          cloudConfig: Prisma.JsonValue;
        };
      } | null;
    } & {
      organization: {
        id: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        cloudConfig: Prisma.JsonValue;
      } | null;
    },
  ) {
    const { orgId, cloudConfig } = this.extractOrgIdAndCloudConfig(
      apiKeyAndOrganisation,
    );

    const newApiKey = OrgEnrichedApiKey.parse({
      ...apiKeyAndOrganisation,
      createdAt: apiKeyAndOrganisation.createdAt?.toISOString(),
      orgId,
      plan: getOrganizationPlanServerSide(cloudConfig),
      rateLimitOverrides: cloudConfig?.rateLimitOverrides,
    });

    if (!orgId) {
      logger.error("No organization found for key");
      throw new Error("Invalid credentials");
    }

    return newApiKey;
  }
}
