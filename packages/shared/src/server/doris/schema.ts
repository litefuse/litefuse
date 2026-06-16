export const DorisTableNames = {
  traces: "traces",
  observations: "observations",
  scores: "scores",
  dataset_run_items_rmt: "dataset_run_items_rmt",
  events_full: "events_full",

  // Virtual tables for dashboards
  // TODO: Check if we can do this more elegantly
  scores_numeric: "scores_numeric",
  scores_categorical: "scores_categorical",
} as const;

export type DorisTableName = keyof typeof DorisTableNames;
