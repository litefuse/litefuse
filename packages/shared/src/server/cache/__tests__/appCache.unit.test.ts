import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLocalAppCache,
  consumeAppCacheRateLimit,
  deleteAppCacheByPrefixes,
  deleteAppCacheKeys,
  deleteExpiredAppCacheEntries,
  getAppCacheValue,
  getLocalAppCacheEntryForTest,
  setAppCacheValue,
  setAppCacheValueIfAbsent,
} from "../appCache";

const wait = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const buildKey = (label: string): string =>
  `test:app-cache:${label}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

describe("appCache", () => {
  beforeEach(() => {
    clearLocalAppCache();
  });

  it("stores values, returns them, and extends TTL when requested", async () => {
    const key = buildKey("touch-ttl");

    await setAppCacheValue(key, { foo: "bar" }, { ttlSeconds: 1 });

    const firstEntry = getLocalAppCacheEntryForTest(key);
    expect(firstEntry?.expiresAt).toBeInstanceOf(Date);

    await wait(250);

    expect(
      await getAppCacheValue<{ foo: string }>(key, { touchTtlSeconds: 3 }),
    ).toEqual({ foo: "bar" });

    const touchedEntry = getLocalAppCacheEntryForTest(key);
    expect(touchedEntry?.expiresAt).toBeInstanceOf(Date);
    expect(touchedEntry!.expiresAt!.getTime()).toBeGreaterThan(
      firstEntry!.expiresAt!.getTime(),
    );

    await wait(1_200);

    expect(await getAppCacheValue<{ foo: string }>(key)).toEqual({
      foo: "bar",
    });
  });

  it("creates values once and only overwrites expired entries", async () => {
    const key = buildKey("if-absent");

    expect(
      await setAppCacheValueIfAbsent(key, "first", { ttlSeconds: 60 }),
    ).toBe(true);
    expect(
      await setAppCacheValueIfAbsent(key, "second", { ttlSeconds: 60 }),
    ).toBe(false);
    expect(await getAppCacheValue<string>(key)).toBe("first");

    await setAppCacheValue(key, "expired", { ttlSeconds: 1 });
    await wait(1_200);

    expect(
      await setAppCacheValueIfAbsent(key, "fresh", { ttlSeconds: 60 }),
    ).toBe(true);
    expect(await getAppCacheValue<string>(key)).toBe("fresh");
  });

  it("deletes cache entries by explicit keys and prefixes", async () => {
    const baseKey = buildKey("delete");
    const deleteKey = `${baseKey}:key`;
    const prefixOne = `${baseKey}:prefix-one:a`;
    const prefixTwo = `${baseKey}:prefix-two:b`;

    await setAppCacheValue(deleteKey, "value");
    await setAppCacheValue(prefixOne, "value");
    await setAppCacheValue(prefixTwo, "value");

    await deleteAppCacheKeys([deleteKey]);
    await deleteAppCacheByPrefixes([
      `${baseKey}:prefix-one:`,
      `${baseKey}:prefix-two:`,
    ]);

    expect(await getAppCacheValue(deleteKey)).toBeNull();
    expect(await getAppCacheValue(prefixOne)).toBeNull();
    expect(await getAppCacheValue(prefixTwo)).toBeNull();
  });

  it("tracks rate limits in memory and resets after expiry", async () => {
    const key = buildKey("rate-limit");

    const first = await consumeAppCacheRateLimit(key, 1);
    expect(first.consumedPoints).toBe(1);

    const second = await consumeAppCacheRateLimit(key, 1);
    expect(second.consumedPoints).toBe(2);
    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(
      first.expiresAt.getTime(),
    );

    await wait(1_200);

    const third = await consumeAppCacheRateLimit(key, 1);
    expect(third.consumedPoints).toBe(1);
    expect(third.expiresAt.getTime()).toBeGreaterThan(
      second.expiresAt.getTime(),
    );
  });

  it("physically deletes expired cache entries", async () => {
    const key = buildKey("expired");

    await setAppCacheValue(key, "value", { ttlSeconds: 1 });
    await wait(1_200);

    const deletedCount = await deleteExpiredAppCacheEntries();

    expect(deletedCount).toBe(1);
    expect(await getAppCacheValue(key)).toBeNull();
  });
});
