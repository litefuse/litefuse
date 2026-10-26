// ── LITEFUSE ADDITION (copied from upstream) ────────────────────────────────
// Deterministic evaluation sampling.
//
// The schedulers used `Math.random()` per attempt, which means the same
// trace/observation could be sampled IN on one scheduling attempt and OUT on a
// retry — a retried ingestion event could therefore produce a different (and
// duplicated or missing) set of evaluations. Hashing the target id instead gives
// a stable bucket per trace/observation, so the decision is reproducible and the
// probability still holds across a population.

/* eslint-disable @repo/no-exotic-operators */
import { createHash } from "node:crypto";

const SAMPLING_DOMAIN = "langfuse:evaluation-sampling:v1\0";
const SAMPLING_BUCKET_COUNT = 2 ** 53;

export function getDeterministicSamplingValue(targetId: string) {
  const digest = createHash("sha256")
    .update(SAMPLING_DOMAIN, "utf8")
    .update(targetId, "utf8")
    .digest();

  // JavaScript Numbers represent integers through 2^53 - 1 exactly. Taking
  // 53 hash bits therefore keeps every bucket distinct after conversion.
  const hash53 = digest.readBigUInt64BE(0) >> 11n;

  return Number(hash53) / SAMPLING_BUCKET_COUNT;
}

export function shouldSampleEvaluation(params: {
  samplingValue: number;
  samplingRate: number;
}) {
  const { samplingValue, samplingRate } = params;

  if (samplingRate >= 1) return true;
  if (samplingRate <= 0) return false;

  return samplingValue < samplingRate;
}
