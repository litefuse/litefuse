import type { PoolClient } from "pg";
import { logger } from "../logger";
import { getSharedPostgresPool } from "./postgresPool";

export type LockAcquireResult = "acquired" | "held_by_other" | "skipped";

export type OnUnavailableBehavior = "proceed" | "fail";

const LOCK_NAMESPACE = "litefuse";

const acquireLockQuery =
  "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired";
const releaseLockQuery =
  "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released";
// Read-only probe used by `isPgAdvisoryLockHeld`. Reading `pg_locks`
// never mutates lock state, which is critical: the previous "try
// acquire then unlock" probe could leak a session-held lock onto a
// pool client whenever the release step missed (catch path, network
// blip), and once leaked, every subsequent probe on that connection
// was reentrant — acquire returned true (count: N→N+1), unlock
// returned t (N+1→N), but count never reached 0. The lock then
// looked held from every *other* session forever, until the pool
// client was recycled. Two-arg advisory locks land in pg_locks with
// objsubid=2 and the two int4 keys cast to oid.
const inspectLockQuery = `
  SELECT EXISTS (
    SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory'
      AND classid = hashtext($1)::oid
      AND objid   = hashtext($2)::oid
      AND objsubid = 2
      AND granted = true
  ) AS held
`;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class PgAdvisoryLock {
  private client: PoolClient | null = null;
  private readonly ttlSeconds: number;
  private readonly name: string;
  private readonly onUnavailable: OnUnavailableBehavior;
  private releaseTimer: NodeJS.Timeout | null = null;
  private releasePromise: Promise<boolean> | null = null;

  public get key(): string {
    return this.lockKey;
  }

  constructor(
    private readonly lockKey: string,
    options: {
      ttlSeconds: number;
      name?: string;
      onUnavailable?: OnUnavailableBehavior;
    },
  ) {
    this.ttlSeconds = options.ttlSeconds;
    this.name = options.name ?? lockKey;
    this.onUnavailable = options.onUnavailable ?? "proceed";
  }

  public async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const lockResult = await this.acquire();
    const shouldProceed =
      lockResult === "acquired" ||
      (lockResult === "skipped" && this.onUnavailable === "proceed");

    if (!shouldProceed) {
      return null;
    }

    try {
      return await fn();
    } finally {
      if (lockResult === "acquired") {
        await this.release();
      }
    }
  }

  public async acquire(): Promise<LockAcquireResult> {
    await sleep(Math.random() * 10);

    try {
      const client = await getSharedPostgresPool().connect();
      const result = await client.query<{ acquired: boolean }>(
        acquireLockQuery,
        [LOCK_NAMESPACE, this.lockKey],
      );
      const acquired = Boolean(result.rows[0]?.acquired);

      if (!acquired) {
        client.release();
        return "held_by_other";
      }

      this.client = client;
      this.scheduleAutoRelease();
      logger.debug(`[${this.name}] Acquired advisory lock`);
      return "acquired";
    } catch (error) {
      logger.error(
        `[${this.name}] Failed to acquire advisory lock due to an error`,
        error,
      );
      return "skipped";
    }
  }

  public async release(): Promise<boolean> {
    if (this.releasePromise) {
      return this.releasePromise;
    }

    if (!this.client) {
      return false;
    }

    this.releasePromise = this.releaseInternal();

    try {
      return await this.releasePromise;
    } finally {
      this.releasePromise = null;
    }
  }

  private async releaseInternal(): Promise<boolean> {
    const client = this.client;
    this.client = null;
    this.clearReleaseTimer();

    if (!client) {
      return false;
    }

    try {
      const result = await client.query<{ released: boolean }>(
        releaseLockQuery,
        [LOCK_NAMESPACE, this.lockKey],
      );
      const released = Boolean(result.rows[0]?.released);

      if (released) {
        logger.debug(`[${this.name}] Released advisory lock`);
      } else {
        logger.warn(
          `[${this.name}] Advisory lock was not released (already unlocked)`,
        );
      }

      return released;
    } catch (error) {
      logger.error(`[${this.name}] Failed to release advisory lock`, error);
      return false;
    } finally {
      client.release();
    }
  }

  private scheduleAutoRelease(): void {
    this.clearReleaseTimer();

    if (this.ttlSeconds <= 0) {
      return;
    }

    this.releaseTimer = setTimeout(() => {
      logger.warn(
        `[${this.name}] Advisory lock exceeded ${this.ttlSeconds}s and will be released`,
      );
      void this.release();
    }, this.ttlSeconds * 1000);

    this.releaseTimer.unref?.();
  }

  private clearReleaseTimer(): void {
    if (!this.releaseTimer) {
      return;
    }

    clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }
}

export const isPgAdvisoryLockHeld = async (
  lockKey: string,
): Promise<boolean> => {
  let client: PoolClient | null = null;

  try {
    client = await getSharedPostgresPool().connect();
    const result = await client.query<{ held: boolean }>(inspectLockQuery, [
      LOCK_NAMESPACE,
      lockKey,
    ]);
    return Boolean(result.rows[0]?.held);
  } catch (error) {
    logger.error(`Failed to inspect advisory lock ${lockKey}`, error);
    return false;
  } finally {
    client?.release();
  }
};
