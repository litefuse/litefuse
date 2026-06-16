import { LRUCache } from "lru-cache";
import type { Prisma } from "../../db";

type AppCacheSetOptions = {
  ttlSeconds?: number | null;
};

type AppCacheGetOptions = {
  touchTtlSeconds?: number | null;
};

type MemoryCacheEntry = {
  value: Prisma.JsonValue | Prisma.InputJsonValue;
  expiresAt: number | null;
};

type RateLimitCounterRow = {
  consumedPoints: number;
  expiresAt: Date;
};

type AppCacheTestEntry = {
  key: string;
  value: Prisma.JsonValue | Prisma.InputJsonValue;
  expiresAt: Date | null;
};

const DEFAULT_APP_CACHE_MAX_ENTRIES = 10_000;

declare global {
  var langfuseAppCacheStore: LRUCache<string, MemoryCacheEntry> | undefined;
}

const getExpiryMillis = (ttlSeconds?: number | null): number | null => {
  if (ttlSeconds == null) {
    return null;
  }

  return Date.now() + ttlSeconds * 1000;
};

const serializeValue = (value: unknown): string => JSON.stringify(value);

const normalizeValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(serializeValue(value)) as Prisma.InputJsonValue;

const getAppCacheStore = (): LRUCache<string, MemoryCacheEntry> => {
  globalThis.langfuseAppCacheStore ??= new LRUCache({
    max: DEFAULT_APP_CACHE_MAX_ENTRIES,
    updateAgeOnGet: true,
  });

  return globalThis.langfuseAppCacheStore;
};

const isExpired = (entry: MemoryCacheEntry): boolean =>
  entry.expiresAt !== null && entry.expiresAt <= Date.now();

const getLiveEntry = (key: string): MemoryCacheEntry | null => {
  const entry = getAppCacheStore().get(key);
  if (!entry) {
    return null;
  }

  if (isExpired(entry)) {
    getAppCacheStore().delete(key);
    return null;
  }

  return entry;
};

const setEntry = (
  key: string,
  value: Prisma.JsonValue | Prisma.InputJsonValue,
  expiresAt: number | null,
): void => {
  getAppCacheStore().set(key, {
    value,
    expiresAt,
  });
};

const getEntryForTest = (key: string): AppCacheTestEntry | null => {
  const entry = getLiveEntry(key);
  if (!entry) {
    return null;
  }

  return {
    key,
    value: entry.value,
    expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt),
  };
};

export const clearLocalAppCache = (): void => {
  getAppCacheStore().clear();
};

export const getLocalAppCacheKeysForTest = (): string[] =>
  Array.from(getAppCacheStore().keys()).filter(
    (key) => getLiveEntry(key) !== null,
  );

export const getLocalAppCacheEntryForTest = (
  key: string,
): AppCacheTestEntry | null => getEntryForTest(key);

export async function getAppCacheValue<T>(
  key: string,
  options?: AppCacheGetOptions,
): Promise<T | null> {
  const entry = getLiveEntry(key);

  if (!entry) {
    return null;
  }

  if (options?.touchTtlSeconds !== undefined) {
    const touchedExpiresAt = getExpiryMillis(options.touchTtlSeconds);
    setEntry(key, entry.value, touchedExpiresAt);
  }

  return entry.value as T;
}

export async function deleteExpiredAppCacheEntries(): Promise<number> {
  const cache = getAppCacheStore();
  let deletedCount = 0;

  for (const [key, entry] of Array.from(cache.entries())) {
    if (!isExpired(entry)) {
      continue;
    }

    cache.delete(key);
    deletedCount += 1;
  }

  return deletedCount;
}

export async function hasAppCacheKey(key: string): Promise<boolean> {
  const value = await getAppCacheValue(key);
  return value !== null;
}

export async function setAppCacheValue(
  key: string,
  value: unknown,
  options?: AppCacheSetOptions,
): Promise<void> {
  setEntry(key, normalizeValue(value), getExpiryMillis(options?.ttlSeconds));
}

export async function setAppCacheValueIfAbsent(
  key: string,
  value: unknown,
  options?: AppCacheSetOptions,
): Promise<boolean> {
  if (getLiveEntry(key)) {
    return false;
  }

  setEntry(key, normalizeValue(value), getExpiryMillis(options?.ttlSeconds));
  return true;
}

export async function deleteAppCacheKey(key: string): Promise<void> {
  getAppCacheStore().delete(key);
}

export async function deleteAppCacheKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  const cache = getAppCacheStore();
  for (const key of keys) {
    cache.delete(key);
  }
}

export async function deleteAppCacheByPrefix(prefix: string): Promise<void> {
  const cache = getAppCacheStore();

  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

export async function deleteAppCacheByPrefixes(
  prefixes: string[],
): Promise<void> {
  if (prefixes.length === 0) {
    return;
  }

  const cache = getAppCacheStore();

  for (const key of Array.from(cache.keys())) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      cache.delete(key);
    }
  }
}

export async function consumeAppCacheRateLimit(
  key: string,
  durationSeconds: number,
): Promise<RateLimitCounterRow> {
  const entry = getLiveEntry(key);
  const nextConsumedPoints =
    entry &&
    typeof entry.value === "object" &&
    entry.value !== null &&
    "consumedPoints" in entry.value &&
    typeof entry.value.consumedPoints === "number"
      ? entry.value.consumedPoints + 1
      : 1;
  const expiresAt = entry?.expiresAt ?? getExpiryMillis(durationSeconds);

  if (expiresAt === null) {
    throw new Error(`Failed to compute rate-limit expiry for cache key ${key}`);
  }

  setEntry(
    key,
    normalizeValue({ consumedPoints: nextConsumedPoints }),
    expiresAt,
  );

  return {
    consumedPoints: nextConsumedPoints,
    expiresAt: new Date(expiresAt),
  };
}
