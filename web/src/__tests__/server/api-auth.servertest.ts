import {
  API_KEY_NON_EXISTENT,
  clearAppCacheByPrefix,
  createBasicAuthHeader,
  createOrgProjectAndApiKey,
  createShaHash,
  getAppCacheEntry,
  getLocalAppCacheKeysSnapshot,
  getAppCacheValueForTest,
  OrgEnrichedApiKey,
  setAppCacheValue,
} from "@langfuse/shared/src/server";
import { Prisma, prisma } from "@langfuse/shared/src/db";
import { env } from "@/src/env.mjs";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { v4 } from "uuid";

describe("Authenticate API calls", () => {
  type TestApiKeyFixture = {
    id: string;
    auth: string;
    publicKey: string;
    secretKey: string;
    orgId: string;
    projectId: string;
    note: string;
  };

  let testApiKey: TestApiKeyFixture;
  const originalCloudRegion = env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;
  const originalProcessCloudRegion =
    process.env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;

  const getValidAuthHeader = () => testApiKey.auth;
  const getInvalidAuthHeader = () =>
    createBasicAuthHeader(
      testApiKey.publicKey,
      `${testApiKey.secretKey}-wrong`,
    );
  const createMissingAuthHeader = () =>
    createBasicAuthHeader(`pk-missing-${v4()}`, `sk-missing-${v4()}`);

  beforeAll(() => {
    (env as any).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "test-region";
    process.env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "test-region";
  });

  afterAll(() => {
    (env as any).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = originalCloudRegion;

    if (originalProcessCloudRegion === undefined) {
      delete process.env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;
    } else {
      process.env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION =
        originalProcessCloudRegion;
    }
  });

  beforeEach(async () => {
    await clearAppCacheByPrefix("api-key:");

    const fixture = await createOrgProjectAndApiKey({ plan: "Hobby" });
    const note = "seeded key";
    const createdApiKey = await prisma.apiKey.findUniqueOrThrow({
      where: { publicKey: fixture.publicKey },
    });
    await prisma.apiKey.update({
      where: { id: createdApiKey.id },
      data: { note },
    });
    testApiKey = {
      id: createdApiKey.id,
      auth: fixture.auth,
      publicKey: fixture.publicKey,
      secretKey: fixture.secretKey,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      note,
    };
  });

  afterEach(async () => {
    await clearAppCacheByPrefix("api-key:");
  });

  describe("basic verification", () => {
    it("should create fast hash on first successful auth", async () => {
      const auth = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(getValidAuthHeader());

      expect(auth.validKey).toBe(true);

      const apiKey = await prisma.apiKey.findUnique({
        where: { publicKey: testApiKey.publicKey },
      });
      expect(apiKey?.fastHashedSecretKey).not.toBeNull();
    });

    it("should succeed repeatedly after fast hash was created", async () => {
      const auth = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(getValidAuthHeader());
      expect(auth.validKey).toBe(true);

      const auth2 = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(getValidAuthHeader());
      expect(auth2.validKey).toBe(true);
    });

    it("should fail on wrong api key with fast hash present", async () => {
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const wrongAuth = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(getInvalidAuthHeader());
      expect(wrongAuth.validKey).toBe(false);
    });

    it("should fail on wrong api key without fast hash", async () => {
      const initialApiKey = await prisma.apiKey.findUnique({
        where: { publicKey: testApiKey.publicKey },
      });
      expect(initialApiKey?.fastHashedSecretKey).toBeNull();

      const auth = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(getInvalidAuthHeader());
      expect(auth.validKey).toBe(false);

      const apiKey = await prisma.apiKey.findUnique({
        where: { publicKey: testApiKey.publicKey },
      });
      expect(apiKey?.fastHashedSecretKey).toBeNull();
    });

    it("should carry cloud config derived rate limits into the auth scope", async () => {
      await prisma.organization.update({
        where: { id: testApiKey.orgId },
        data: {
          cloudConfig: {
            rateLimitOverrides: [
              {
                resource: "ingestion",
                points: 100,
                durationInSec: 60,
              },
            ],
          },
        },
      });

      const auth = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(getValidAuthHeader());
      expect(auth.validKey).toBe(true);

      if (auth.validKey) {
        expect(auth.scope.orgId).toBe(testApiKey.orgId);
        expect(auth.scope.plan).toBe("cloud:hobby");
        expect(auth.scope.rateLimitOverrides).toEqual([
          {
            resource: "ingestion",
            points: 100,
            durationInSec: 60,
          },
        ]);
      }

      await prisma.organization.update({
        where: { id: testApiKey.orgId },
        data: { cloudConfig: Prisma.JsonNull },
      });
    });
  });

  describe("app cache", () => {
    const getFastHash = async () => {
      const apiKey = await prisma.apiKey.findUniqueOrThrow({
        where: { publicKey: testApiKey.publicKey },
      });
      expect(apiKey.fastHashedSecretKey).not.toBeNull();
      return apiKey.fastHashedSecretKey as string;
    };

    it("should populate app cache on the second auth lookup", async () => {
      await prisma.organization.update({
        where: { id: testApiKey.orgId },
        data: {
          cloudConfig: {
            rateLimitOverrides: [
              {
                resource: "public-api",
                points: 1000,
                durationInSec: 60,
              },
              {
                resource: "ingestion",
              },
            ],
          },
        },
      });

      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const fastHash = await getFastHash();
      expect(await getAppCacheValueForTest(`api-key:${fastHash}`)).toBeNull();

      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const cachedKey = await getAppCacheValueForTest(`api-key:${fastHash}`);
      const parsed = OrgEnrichedApiKey.parse(cachedKey);

      expect(parsed).toEqual({
        id: expect.any(String),
        note: "seeded key",
        publicKey: testApiKey.publicKey,
        hashedSecretKey: expect.any(String),
        fastHashedSecretKey: fastHash,
        displaySecretKey: expect.any(String),
        createdAt: expect.any(String),
        lastUsedAt: null,
        expiresAt: null,
        projectId: testApiKey.projectId,
        orgId: testApiKey.orgId,
        plan: "cloud:hobby",
        scope: "PROJECT",
        rateLimitOverrides: [
          {
            resource: "public-api",
            points: 1000,
            durationInSec: 60,
          },
          {
            resource: "ingestion",
          },
        ],
      });

      await prisma.organization.update({
        where: { id: testApiKey.orgId },
        data: { cloudConfig: Prisma.JsonNull },
      });
    });

    it("should fall back to Postgres and heal invalid cached payloads", async () => {
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );
      const fastHash = await getFastHash();

      await setAppCacheValue(
        `api-key:${fastHash}`,
        {
          id: "seed-api-key",
          note: "seeded key",
          publicKey: testApiKey.publicKey,
          displaySecretKey: "sk-lf-...7890",
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          expiresAt: null,
          fastHashedSecretKey: fastHash,
          hashedSecretKey: "hashed",
          orgId: testApiKey.orgId,
          plan: "cloud:team",
          projectId: testApiKey.projectId,
        },
        { ttlSeconds: env.LITEFUSE_CACHE_API_KEY_TTL_SECONDS },
      );

      const verification = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(getValidAuthHeader());
      expect(verification.validKey).toBe(true);

      const healed = await getAppCacheValueForTest(`api-key:${fastHash}`);
      const parsed = OrgEnrichedApiKey.parse(healed);
      expect(parsed.scope).toBe("PROJECT");
      expect(parsed.plan).toBe("cloud:hobby");
    });

    it("should cache non-existent keys and fail auth", async () => {
      const missingAuthHeader = createMissingAuthHeader();

      const verification = await new ApiAuthService(
        prisma,
      ).verifyAuthHeaderAndReturnScope(missingAuthHeader);
      expect(verification.validKey).toBe(false);

      const missingSecret = missingAuthHeader.split(" ")[1];
      const decoded = Buffer.from(missingSecret!, "base64").toString("utf-8");
      const [, secret] = decoded.split(":");
      const hash = createShaHash(secret!, env.SALT);

      const cached = await getAppCacheValueForTest(`api-key:${hash}`);
      expect(cached).toBe(API_KEY_NON_EXISTENT);
    });

    it("should read cached keys without hitting prisma", async () => {
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const findUniqueSpy = jest.spyOn(prisma.apiKey, "findUnique");
      findUniqueSpy.mockClear();

      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      expect(findUniqueSpy).not.toHaveBeenCalled();
      findUniqueSpy.mockRestore();
    });

    it("should extend TTL when reading cached keys", async () => {
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const fastHash = await getFastHash();
      const key = `api-key:${fastHash}`;
      const firstEntry = await getAppCacheEntry(key);
      expect(firstEntry?.expiresAt).toBeInstanceOf(Date);

      await new Promise((resolve) => setTimeout(resolve, 1500));

      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const secondEntry = await getAppCacheEntry(key);
      expect(secondEntry?.expiresAt).toBeInstanceOf(Date);
      expect(secondEntry!.expiresAt!.getTime()).toBeGreaterThan(
        firstEntry!.expiresAt!.getTime(),
      );
    }, 10000);

    it("should delete API keys from cache and db", async () => {
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const apiKey = await prisma.apiKey.findUniqueOrThrow({
        where: { publicKey: testApiKey.publicKey },
      });
      const cacheKey = `api-key:${apiKey.fastHashedSecretKey}`;
      expect(await getAppCacheValueForTest(cacheKey)).not.toBeNull();

      await new ApiAuthService(prisma).deleteApiKey(
        apiKey.id,
        apiKey.projectId!,
        "PROJECT",
      );

      expect(
        await prisma.apiKey.findUnique({
          where: { id: apiKey.id },
        }),
      ).toBeNull();
      expect(await getAppCacheValueForTest(cacheKey)).toBeNull();
    });

    it("should refresh organization API keys in cache", async () => {
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const apiKey = await prisma.apiKey.findUniqueOrThrow({
        where: { publicKey: testApiKey.publicKey },
      });
      const cacheKey = `api-key:${apiKey.fastHashedSecretKey}`;
      expect(await getAppCacheValueForTest(cacheKey)).not.toBeNull();

      await new ApiAuthService(prisma).refreshCachedOrgApiKeys(
        testApiKey.orgId,
      );

      expect(await getAppCacheValueForTest(cacheKey)).not.toBeNull();
    });

    it("should refresh project API keys in cache", async () => {
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );
      await new ApiAuthService(prisma).verifyAuthHeaderAndReturnScope(
        getValidAuthHeader(),
      );

      const apiKey = await prisma.apiKey.findUniqueOrThrow({
        where: { publicKey: testApiKey.publicKey },
      });
      const cacheKey = `api-key:${apiKey.fastHashedSecretKey}`;
      expect(await getAppCacheValueForTest(cacheKey)).not.toBeNull();

      await new ApiAuthService(prisma).refreshCachedProjectApiKeys(
        testApiKey.projectId,
      );

      expect(await getAppCacheValueForTest(cacheKey)).not.toBeNull();
    });

    it("should no-op when there are no hashed keys to invalidate", async () => {
      await new ApiAuthService(prisma).refreshCachedOrgApiKeys(
        testApiKey.orgId,
      );
      await new ApiAuthService(prisma).refreshCachedProjectApiKeys(
        testApiKey.projectId,
      );

      expect(
        getLocalAppCacheKeysSnapshot().filter((key) =>
          key.startsWith("api-key:"),
        ),
      ).toHaveLength(0);
    });
  });
});
