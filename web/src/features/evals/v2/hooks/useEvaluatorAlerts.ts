// ── LITEFUSE NOTE (authored stub; replaces upstream's monitors-backed hook) ───
// Upstream owns evaluator alerts through its monitors feature: it reads
// `api.monitors.linkedEvaluatorAlerts` / `linkedAllEvaluatorSpendAlerts` / `count`,
// checks the `monitor-count` entitlement, and gates on the `alerts:read` and
// `alerts:CUD` scopes.
//
// Litefuse has no monitors feature. Per decision M1 the evaluator-alert UI is
// HIDDEN rather than half-implemented — the same treatment every other concept we
// do not have received. Reporting no alerts and no permissions is exactly what the
// surrounding UI renders as "no alert affordances", so the existing components need
// no changes.
//
// Replacement suggestion: if monitors are ever brought over, restore the upstream
// body (it is 56 lines away) and add the two scopes to projectAccessRights.
// ─────────────────────────────────────────────────────────────────────────────

/** Owns evaluator alert permissions, linked-alert loading, and creation limits. */
export function useEvaluatorAlerts(
  _params:
    | { scope: "evaluator"; projectId: string; evaluatorId: string | null }
    | { scope: "allEvaluators"; projectId: string },
) {
  return {
    connectedAlerts: [] as never[],
    hasMore: false,
    isLoading: false,
    // No monitors means no alert access to grant — the UI reads these to decide
    // whether to offer the affordances at all.
    canRead: false,
    canCreate: false,
    limitReached: false,
  };
}
