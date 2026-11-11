import { env } from "@langfuse/shared/src/env";
import {
  dorisClient,
  metricsAggTableFor,
  tableFor,
} from "@langfuse/shared/src/server";

const SHARED_PROJECT_TABLES = new Set([
  "scores",
  "event_log",
  "project_environments",
  "dataset_run_items",
  "dataset_run_items_rmt",
]);

export class DiscoverQueryError extends Error {
  constructor(
    message: string,
    readonly code: "BAD_REQUEST" | "FORBIDDEN" = "BAD_REQUEST",
  ) {
    super(message);
  }
}

export function discoverDatabase(database = env.DORIS_DB): string {
  if (database !== env.DORIS_DB) {
    throw new DiscoverQueryError(
      "Database is unavailable in Discover",
      "FORBIDDEN",
    );
  }
  return database;
}

export function discoverTableScope(
  projectId: string,
  table: string,
): "split" | "shared" | undefined {
  if (SHARED_PROJECT_TABLES.has(table)) return "shared";
  if (
    table === tableFor(projectId, "spans") ||
    table === tableFor(projectId, "traces_scalar") ||
    table === metricsAggTableFor(projectId)
  ) {
    return "split";
  }
}

export function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

export function discoverDatabases() {
  return [{ Database: discoverDatabase() }];
}

export async function discoverTables(projectId: string, requestedDb: string) {
  const database = discoverDatabase(requestedDb);
  const rows = await dorisClient({ database }).query(
    `SHOW TABLES FROM ${quoteIdentifier(database)}`,
  );
  return rows.filter((row: Record<string, unknown>) => {
    const name = Object.values(row)[0];
    return typeof name === "string" && discoverTableScope(projectId, name);
  });
}

export function discoverTableMetadata(
  action: "fields" | "indexes",
  projectId: string,
  requestedDb: string,
  table: string,
) {
  const database = discoverDatabase(requestedDb);
  if (!discoverTableScope(projectId, table)) {
    throw new DiscoverQueryError(
      "Table is unavailable in Discover",
      "FORBIDDEN",
    );
  }
  const kind = action === "fields" ? "COLUMNS" : "INDEXES";
  return dorisClient({ database }).query(
    `SHOW ${kind} FROM ${quoteIdentifier(database)}.${quoteIdentifier(table)}`,
  );
}
