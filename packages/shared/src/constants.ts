// disable lint as this is exported and used in packages

/**
 * Minimum per-project retention (days) that a non-zero data-retention value may
 * be set to (UI + API validation floor). Mirrors the Doris split-table floor
 * (RETENTION_FLOOR_DAYS): below it a day-partition could be dropped while a job
 * targeting it is still redrivable / reconcilable (silent data loss). 0 = no
 * TTL (indefinite retention) remains allowed; values 1..floor-1 are rejected.
 * Single source of truth — validation messages / schemas build on this.
 */
export const RETENTION_FLOOR_DAYS = 7;

export enum ModelUsageUnit {
  Characters = "CHARACTERS",
  Tokens = "TOKENS",
  Seconds = "SECONDS",
  Milliseconds = "MILLISECONDS",
  Images = "IMAGES",
  Requests = "REQUESTS",
}
