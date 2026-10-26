/**
 * Four-way classification for the otel S3↔ledger reconciliation. Pure — the
 * script feeds it facts, tests drive it directly.
 *
 * Threshold contract: olderThanMs must sit BETWEEN the DLQ age
 * guard (label_keep_max_second, default 3d — nothing still redrivable may be
 * re-injected) and the registered-key TTL (default 4d — inside the TTL the
 * key's existence is the "entered the pipeline" evidence that separates a
 * lost pointer from an orphan). Outside that band the auto-reinject
 * category degenerates and everything unexplained falls to manual audit.
 */

export type OtelFileFacts = {
  fileKey: string;
  /** S3 object creation time (epoch ms). */
  createdAtMs: number;
  /** A blob_storage_file_log row exists (entity_type=otel-file, ANY is_deleted). */
  hasLedger: boolean;
  /** Listed in the PG poison ledger (deterministic failure — do not touch). */
  isPoisoned: boolean;
  /** registered:{fileKey} still exists on some shard. */
  hasRegisteredKey: boolean;
};

export type OtelFileVerdict =
  | { verdict: "ok" } // ledger exists — completed end-to-end
  | { verdict: "in-flight" } // no ledger but younger than the threshold
  | { verdict: "poisoned" } // tracked in otel_poison_jobs — manual, not auto
  | { verdict: "reinject" } // over-age + registered trace ⇒ lost pointer
  | { verdict: "audit"; reason: string }; // over-age, no evidence — manual

export const classifyOtelFile = (
  facts: OtelFileFacts,
  params: { now: number; olderThanMs: number },
): OtelFileVerdict => {
  if (facts.hasLedger) return { verdict: "ok" };
  const age = params.now - facts.createdAtMs;
  if (age < params.olderThanMs) return { verdict: "in-flight" };
  // Poison outranks re-injection: a deterministically failing group would
  // just fail again — its disposition is the poison runbook, not the pipe.
  if (facts.isPoisoned) return { verdict: "poisoned" };
  if (facts.hasRegisteredKey) return { verdict: "reinject" };
  // No ledger, over-age, no registration trace: either an orphan (web
  // crashed pre-registration — the SDK re-sent a fresh copy, re-injection
  // would DUPLICATE data) or a loss older than the registered TTL. Not
  // distinguishable mechanically → human decision.
  return {
    verdict: "audit",
    reason: "no ledger, over-age, no registration trace (A2 orphan vs expired loss)",
  };
};
