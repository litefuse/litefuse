// LITEFUSE NOTE: this file is new; upstream declares this constant in navigate-detail-pages/context.tsx.
//
// Our (older) context.tsx has no `detailPageListKeys`, and adding it there would
// mean editing a file outside the evaluator module. It is declared here instead
// and re-exported from this feature's new door. Values are copied from upstream
// so the key set stays comparable.
export const detailPageListKeys = {
  traces: "traces",
  observations: "observations",
  events: "events",
  sessions: "sessions",
  evalTemplates: "eval-templates",
} as const;
