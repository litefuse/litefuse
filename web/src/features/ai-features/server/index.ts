// ── LITEFUSE NOTE (authored stub, not upstream code) ────────────────────────
// Upstream: \`web/src/features/ai-features/server/availability.ts\` answers "are AI
// features usable here?" by checking Cloud region, then org/project flags, then
// whether a model is configured. It imports
// \`@langfuse/shared/in-app-agent/server/modelProvider\`, so copying it drags in
// the whole in-app-agent subsystem.
//
// Litefuse decision: the whole in-app AI agent is PARKED pending a full review,
// which must consider the Cloud build as well as self-hosted. Until that review
// lands, this answers "unavailable", so every caller takes its already-written
// \`if (!availability.available) return null\` branch and no AI affordance appears.
//
// Replacement suggestion: when the review lands, decide once whether self-hosted
// deployments may bring their own key; if yes, implement it here against our own
// model configuration rather than porting upstream's subsystem.
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors upstream's discriminated union: the model id is a plain string, and it
// only exists on the available branch, so callers that return early on
// `!availability.available` see a `string` afterwards.
export type LangfuseAiFeatureAvailability =
  | { available: false; reason: "self-hosted" | "not-configured" }
  | { available: true; model: string };
export async function resolveLangfuseAiFeatureAvailability(_params: {
  prisma: unknown;
  projectId: string;
}): Promise<LangfuseAiFeatureAvailability> {
  return { available: false, reason: "self-hosted" };
}
