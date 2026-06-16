import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPgAdvisoryLockHeld, PgAdvisoryLock } from "../PgAdvisoryLock";
import { stopSharedPostgresPool } from "../postgresPool";

describe("PgAdvisoryLock", () => {
  const lockKey = `test:pg-advisory-lock:${Date.now()}`;

  beforeEach(async () => {
    await stopSharedPostgresPool();
  });

  afterEach(async () => {
    await stopSharedPostgresPool();
  });

  it("prevents a second holder until released", async () => {
    const firstLock = new PgAdvisoryLock(lockKey, { ttlSeconds: 30 });
    const secondLock = new PgAdvisoryLock(lockKey, { ttlSeconds: 30 });

    expect(await firstLock.acquire()).toBe("acquired");
    expect(await isPgAdvisoryLockHeld(lockKey)).toBe(true);
    expect(await secondLock.acquire()).toBe("held_by_other");

    expect(await firstLock.release()).toBe(true);
    expect(await isPgAdvisoryLockHeld(lockKey)).toBe(false);
    expect(await secondLock.acquire()).toBe("acquired");
    expect(await secondLock.release()).toBe(true);
  });

  it("returns null from withLock when another holder owns the lock", async () => {
    const firstLock = new PgAdvisoryLock(lockKey, { ttlSeconds: 30 });
    const secondLock = new PgAdvisoryLock(lockKey, {
      ttlSeconds: 30,
      onUnavailable: "fail",
    });

    expect(await firstLock.acquire()).toBe("acquired");

    const result = await secondLock.withLock(async () => "should-not-run");
    expect(result).toBeNull();

    expect(await firstLock.release()).toBe(true);
  });

  it("releases the lock after withLock completes", async () => {
    const lock = new PgAdvisoryLock(lockKey, { ttlSeconds: 30 });

    const result = await lock.withLock(async () => "done");

    expect(result).toBe("done");
    expect(await isPgAdvisoryLockHeld(lockKey)).toBe(false);
  });
});
