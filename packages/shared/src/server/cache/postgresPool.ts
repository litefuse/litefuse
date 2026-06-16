import { Pool } from "pg";
import { logger } from "../logger";

declare global {
  var sharedPostgresPool: Pool | undefined;
}

const getConnectionString = (): string => {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DIRECT_URL or DATABASE_URL is required");
  }

  return connectionString;
};

const createSharedPostgresPool = (): Pool => {
  const pool = new Pool({
    connectionString: getConnectionString(),
    application_name: "litefuse-shared",
    max: 5,
  });

  pool.on("error", (error) => {
    logger.error("Shared Postgres pool error", error);
  });

  return pool;
};

export const getSharedPostgresPool = (): Pool => {
  globalThis.sharedPostgresPool ??= createSharedPostgresPool();
  return globalThis.sharedPostgresPool;
};

export const stopSharedPostgresPool = async (): Promise<void> => {
  const pool = globalThis.sharedPostgresPool;
  globalThis.sharedPostgresPool = undefined;

  if (!pool) {
    return;
  }

  await pool.end();
};
