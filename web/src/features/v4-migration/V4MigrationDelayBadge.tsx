// ── LITEFUSE NOTE (authored stub, not upstream code) ────────────────────────
// Upstream renders a page-title badge when a project's telemetry still needs the
// V4 migration (see V4MigrationBadgeContent.tsx for the full reasoning). Litefuse
// has no V4 telemetry migration, so there is never anything to warn about.
//
// Returning null is the honest equivalent: the badge is absent rather than
// pretending a migration is pending.
// ─────────────────────────────────────────────────────────────────────────────

export function V4MigrationUpdateRequiredBadge() {
  return null;
}
