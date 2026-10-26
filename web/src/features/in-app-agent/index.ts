// ── LITEFUSE NOTE (authored stub, not upstream code) ────────────────────────
// Upstream ships a whole in-app agent (conversation runtime, tools, watch route,
// model provider). Litefuse has none of it, and the decision is to PARK the
// feature pending a full review.
//
// These two hooks are all the evaluator tree needs. \`useIsInAppAgentLauncherVisible\`
// returning false makes \`EvaluatorsEmptyState\` pass \`undefined\` for \`onDetectTopics\`,
// i.e. the AI entry point is simply not rendered — which is the agreed outcome
// ("不启用、隐藏相关 UI"). The other hook is kept so the call site stays intact
// if the feature is revived.
//
// Replacement suggestion: if the parked review decides self-hosted should get an
// assistant, implement it as our own feature and wire it here.
// ─────────────────────────────────────────────────────────────────────────────

export function useIsInAppAgentLauncherVisible(): boolean {
  return false;
}

export function useInAppAiAgent(): {
  openAssistant: (entryPoint: string) => boolean;
  submit: (
    prompt: string,
    options?: { newConversation?: boolean; entryPoint?: string },
  ) => Promise<void>;
} {
  return {
    // Mirrors upstream's contract: false means "an enable-AI dialog took over,
    // do not submit into an assistant the user cannot reach".
    openAssistant: () => false,
    submit: async () => undefined,
  };
}
