import {
  createHttpHeaderFromRateLimit,
  RateLimitService,
} from "@/src/features/public-api/server/RateLimitService";
import { env } from "@/src/env.mjs";
import {
  clearAppCacheByPrefix,
  getAppCacheEntry,
  getAppCacheValueForTest,
} from "@langfuse/shared/src/server";

describe("RateLimitService", () => {
  const orgId = "seed-org-id";
  const rateLimitKey = `rate-limit:public-api:${orgId}`;
  const originalCloudRegion = env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;
  const originalRateLimitsEnabled = env.LITEFUSE_RATE_LIMITS_ENABLED;

  beforeAll(() => {
    (env as any).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "test-region";
    (env as any).LITEFUSE_RATE_LIMITS_ENABLED = "true";
  });

  afterAll(() => {
    (env as any).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = originalCloudRegion;
    (env as any).LITEFUSE_RATE_LIMITS_ENABLED = originalRateLimitsEnabled;
  });

  beforeEach(async () => {
    RateLimitService.shutdown();
    await clearAppCacheByPrefix("rate-limit:");
  });

  afterEach(async () => {
    await clearAppCacheByPrefix("rate-limit:");
    RateLimitService.shutdown();
  });

  it("should create correct ratelimit headers", () => {
    const rateLimitRes = {
      points: 1000,
      remainingPoints: 999,
      msBeforeNext: 1000,
      resource: "public-api" as const,
      scope: {
        orgId,
        plan: "cloud:hobby" as const,
        projectId: "test-project-id",
        accessLevel: "project" as const,
        rateLimitOverrides: [],
      },
      consumedPoints: 1,
      isFirstInDuration: true,
    };

    const headers = createHttpHeaderFromRateLimit(rateLimitRes);

    expect(headers).toEqual({
      "Retry-After": 1,
      "X-RateLimit-Limit": 1000,
      "X-RateLimit-Remaining": 999,
      "X-RateLimit-Reset": expect.any(String),
    });
  });

  it("should rate limit", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [],
    };

    const rateLimitService = RateLimitService.getInstance();
    const result = await rateLimitService.rateLimitRequest(scope, "public-api");

    expect(result?.res).toEqual({
      scope,
      resource: "public-api",
      points: 30,
      remainingPoints: 29,
      msBeforeNext: expect.any(Number),
      consumedPoints: 1,
      isFirstInDuration: true,
    });
    expect(result?.isRateLimited()).toBe(false);

    const value = await getAppCacheValueForTest<{ consumedPoints: number }>(
      rateLimitKey,
    );
    expect(value).toEqual({ consumedPoints: 1 });
  });

  it("should increment the rate limit count", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [],
    };

    const rateLimitService = RateLimitService.getInstance();
    await rateLimitService.rateLimitRequest(scope, "public-api");

    const result = await rateLimitService.rateLimitRequest(scope, "public-api");

    expect(result?.res).toEqual({
      scope,
      resource: "public-api",
      points: 30,
      remainingPoints: 28,
      msBeforeNext: expect.any(Number),
      consumedPoints: 2,
      isFirstInDuration: false,
    });
    expect(result?.isRateLimited()).toBe(false);
  });

  it("should reset the rate limit count after the window expires", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [
        { resource: "public-api" as const, points: 100, durationInSec: 2 },
      ],
    };

    const rateLimitService = RateLimitService.getInstance();
    await rateLimitService.rateLimitRequest(scope, "public-api");

    const firstResult = await rateLimitService.rateLimitRequest(
      scope,
      "public-api",
    );
    expect(firstResult?.res).toEqual({
      scope,
      resource: "public-api",
      points: 100,
      remainingPoints: 98,
      msBeforeNext: expect.any(Number),
      consumedPoints: 2,
      isFirstInDuration: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const secondResult = await rateLimitService.rateLimitRequest(
      scope,
      "public-api",
    );
    expect(secondResult?.res).toEqual({
      scope,
      resource: "public-api",
      points: 100,
      remainingPoints: 99,
      msBeforeNext: expect.any(Number),
      consumedPoints: 1,
      isFirstInDuration: true,
    });
    expect(secondResult?.isRateLimited()).toBe(false);
  });

  it("should return false when rate limit is exceeded", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [
        { resource: "public-api" as const, points: 5, durationInSec: 60 },
      ],
    };

    const rateLimitService = RateLimitService.getInstance();
    for (let i = 0; i < 5; i++) {
      await rateLimitService.rateLimitRequest(scope, "public-api");
    }

    const result = await rateLimitService.rateLimitRequest(scope, "public-api");

    expect(result?.res).toEqual({
      scope,
      resource: "public-api",
      points: 5,
      remainingPoints: 0,
      msBeforeNext: expect.any(Number),
      consumedPoints: 6,
      isFirstInDuration: false,
    });
    expect(result?.isRateLimited()).toBe(true);
  });

  it("should apply rate limits with override for specific resource", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [
        { resource: "public-api" as const, points: 5, durationInSec: 10 },
      ],
    };

    const result = await RateLimitService.getInstance().rateLimitRequest(
      scope,
      "public-api",
    );

    expect(result?.res).toEqual({
      scope,
      resource: "public-api",
      points: 5,
      remainingPoints: 4,
      msBeforeNext: expect.any(Number),
      consumedPoints: 1,
      isFirstInDuration: true,
    });
  });

  it("should not apply rate limits for resource prompts", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [
        { resource: "public-api" as const, points: 5, durationInSec: 10 },
      ],
    };

    const result = await RateLimitService.getInstance().rateLimitRequest(
      scope,
      "prompts",
    );

    expect(result?.res).toBeUndefined();
    expect(result?.isRateLimited()).toBe(false);
  });

  it("should not apply rate limits for ingestion when overridden to null in API key", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [
        { resource: "ingestion" as const, points: null, durationInSec: null },
      ],
    };

    const result = await RateLimitService.getInstance().rateLimitRequest(
      scope,
      "ingestion",
    );

    expect(result?.res).toBeUndefined();
  });

  it("should not apply rate limits for OSS plan", async () => {
    const scope = {
      orgId,
      plan: "oss" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [],
    };

    const result = await RateLimitService.getInstance().rateLimitRequest(
      scope,
      "public-api",
    );

    expect(result?.res).toBeUndefined();
    expect(result?.isRateLimited()).toBe(false);
  });

  it("stores expiry metadata in app cache", async () => {
    const scope = {
      orgId,
      plan: "cloud:hobby" as const,
      projectId: "test-project-id",
      accessLevel: "project" as const,
      rateLimitOverrides: [
        { resource: "public-api" as const, points: 5, durationInSec: 10 },
      ],
    };

    await RateLimitService.getInstance().rateLimitRequest(scope, "public-api");

    const entry = await getAppCacheEntry(rateLimitKey);
    expect(entry).not.toBeNull();
    expect(entry?.expiresAt).toBeInstanceOf(Date);
    expect(entry?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });
});
