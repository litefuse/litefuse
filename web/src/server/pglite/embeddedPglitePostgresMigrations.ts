import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prisma, Client } from "@langfuse/shared/src/db";

declare global {
  var embeddedPglitePostgresMigrationPromise: Promise<void> | undefined;
}

const PRISMA_MIGRATIONS_TABLE_NAME = "_prisma_migrations";
const PRISMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
  )
`;

const projectRootCandidates = [
  process.cwd(),
  resolve(process.cwd(), ".."),
  ...(process.env.LITEFUSE_STANDALONE_ROOT
    ? [
        resolve(process.env.LITEFUSE_STANDALONE_ROOT, "app"),
        process.env.LITEFUSE_STANDALONE_ROOT,
      ]
    : []),
];

const resolveProjectPath = (relativePath: string): string => {
  for (const root of projectRootCandidates) {
    const candidate = resolve(root, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not resolve required project path: ${relativePath}`);
};

const escapeSqlLiteral = (value: string): string => value.replaceAll("'", "''");

const buildEmbeddedMigrationId = (migrationName: string): string =>
  createHash("md5").update(`embedded-pglite:${migrationName}`).digest("hex");

const getEmbeddedPrismaMigrationState = async (): Promise<{
  hasPrismaMigrationsTable: boolean;
  hasUserTables: boolean;
  prismaMigrationCount: number;
}> => {
  const [schemaState] = await prisma.$queryRawUnsafe<
    Array<{
      hasPrismaMigrationsTable: boolean;
      userTableCount: number;
    }>
  >(`
    SELECT
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = '${PRISMA_MIGRATIONS_TABLE_NAME}'
      ) AS "hasPrismaMigrationsTable",
      (
        SELECT COUNT(*)::int
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name <> '${PRISMA_MIGRATIONS_TABLE_NAME}'
      ) AS "userTableCount"
  `);

  const hasPrismaMigrationsTable = Boolean(
    schemaState?.hasPrismaMigrationsTable,
  );
  const hasUserTables = Number(schemaState?.userTableCount ?? 0) > 0;

  if (!hasPrismaMigrationsTable) {
    return {
      hasPrismaMigrationsTable,
      hasUserTables,
      prismaMigrationCount: 0,
    };
  }

  const [migrationCountState] = await prisma.$queryRawUnsafe<
    Array<{ count: number }>
  >(`SELECT COUNT(*)::int AS "count" FROM "${PRISMA_MIGRATIONS_TABLE_NAME}"`);

  return {
    hasPrismaMigrationsTable,
    hasUserTables,
    prismaMigrationCount: Number(migrationCountState?.count ?? 0),
  };
};

const shouldBaselineEmbeddedPrismaMigrations = (state: {
  hasPrismaMigrationsTable: boolean;
  hasUserTables: boolean;
  prismaMigrationCount: number;
}): boolean =>
  state.hasUserTables &&
  (!state.hasPrismaMigrationsTable || state.prismaMigrationCount === 0);

const buildEmbeddedPrismaMigrationBaselineSql = async (): Promise<string> => {
  const migrationsDir = resolveProjectPath("packages/shared/prisma/migrations");
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  const migrations = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const migrationSql = await readFile(
          resolve(migrationsDir, entry.name, "migration.sql"),
          "utf8",
        );

        return {
          id: buildEmbeddedMigrationId(entry.name),
          checksum: createHash("sha256").update(migrationSql).digest("hex"),
          migrationName: entry.name,
        };
      }),
  );

  const sortedMigrations = migrations.sort((left, right) =>
    left.migrationName.localeCompare(right.migrationName),
  );

  if (sortedMigrations.length === 0) {
    throw new Error("No Prisma migrations found for embedded PGlite baseline");
  }

  const valuesSql = sortedMigrations
    .map(
      ({ id, checksum, migrationName }) =>
        `('${escapeSqlLiteral(id)}', '${escapeSqlLiteral(checksum)}', now(), '${escapeSqlLiteral(
          migrationName,
        )}', NULL::text, NULL::timestamptz, now(), 1)`,
    )
    .join(",\n");

  return `
    INSERT INTO "${PRISMA_MIGRATIONS_TABLE_NAME}" (
      "id",
      "checksum",
      "finished_at",
      "migration_name",
      "logs",
      "rolled_back_at",
      "started_at",
      "applied_steps_count"
    )
    SELECT *
    FROM (
      VALUES
      ${valuesSql}
    ) AS baseline (
      "id",
      "checksum",
      "finished_at",
      "migration_name",
      "logs",
      "rolled_back_at",
      "started_at",
      "applied_steps_count"
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM "${PRISMA_MIGRATIONS_TABLE_NAME}"
    )
  `;
};

const baselineEmbeddedPrismaMigrationHistory = async (): Promise<void> => {
  console.log(
    "[pglite] detected existing embedded schema without Prisma migration history; baselining _prisma_migrations",
  );

  await prisma.$executeRawUnsafe(PRISMA_MIGRATIONS_TABLE_SQL);
  await prisma.$executeRawUnsafe(
    await buildEmbeddedPrismaMigrationBaselineSql(),
  );
};

const buildPgliteClientConfig = (): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} => {
  const rawUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      "DIRECT_URL or DATABASE_URL is required for embedded Postgres migrations",
    );
  }

  // Mirror the defaults used by embeddedPglite.ts so the client always
  // points at the PGlite wire server even when the URL omits host/port.
  const url = new URL(rawUrl);

  return {
    host: url.hostname || process.env.PGLITE_HOST || "127.0.0.1",
    port: Number(url.port || process.env.PGLITE_PORT || 55432),
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || "postgres"),
    database: (url.pathname || "/postgres").replace(/^\//, "") || "postgres",
  };
};

const createPgliteClient = (): Client => new Client(buildPgliteClientConfig());

const applyEmbeddedMigrations = async (): Promise<void> => {
  const migrationsDir = resolveProjectPath("packages/shared/prisma/migrations");
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  // Ensure _prisma_migrations table exists (via Prisma for consistency).
  await prisma.$executeRawUnsafe(PRISMA_MIGRATIONS_TABLE_SQL);

  // Get already applied migration names.
  const applied = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string }>
  >(`SELECT "migration_name" FROM "${PRISMA_MIGRATIONS_TABLE_NAME}"`);
  const appliedNames = new Set(applied.map((r) => r.migration_name));

  const pending = entries
    .filter((entry) => entry.isDirectory() && !appliedNames.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (pending.length === 0) {
    console.log("[pglite] all migrations already applied");
    return;
  }

  console.log(`[pglite] applying ${pending.length} pending migration(s)`);

  // pg.Client uses the simple query protocol which executes multi-statement
  // SQL files natively — no regex splitting needed.
  const pgClient = createPgliteClient();
  await pgClient.connect();

  try {
    for (const entry of pending) {
      const migrationSql = await readFile(
        resolve(migrationsDir, entry.name, "migration.sql"),
        "utf8",
      );
      const checksum = createHash("sha256").update(migrationSql).digest("hex");
      const id = buildEmbeddedMigrationId(entry.name);

      console.log(`[pglite]   applying ${entry.name}...`);

      // CONCURRENTLY is unnecessary in a single-user embedded database but
      // cannot run inside a transaction; strip it here just in case.
      await pgClient.query(migrationSql.replace(/\bCONCURRENTLY\b/gi, ""));

      // Record the migration via Prisma.
      await prisma.$executeRawUnsafe(`
        INSERT INTO "${PRISMA_MIGRATIONS_TABLE_NAME}" (
          "id", "checksum", "finished_at", "migration_name",
          "logs", "rolled_back_at", "started_at", "applied_steps_count"
        ) VALUES (
          '${escapeSqlLiteral(id)}',
          '${escapeSqlLiteral(checksum)}',
          now(),
          '${escapeSqlLiteral(entry.name)}',
          NULL,
          NULL,
          now(),
          1
        )
      `);

      console.log(`[pglite]   ✓ ${entry.name}`);
    }
  } finally {
    await pgClient.end();
  }
};

const runEmbeddedPglitePostgresMigrationsOnce = async (): Promise<void> => {
  if (process.env.LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED === "true") {
    return;
  }

  const directUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!directUrl) {
    throw new Error(
      "DIRECT_URL or DATABASE_URL is required for embedded Postgres migrations",
    );
  }

  process.env.DIRECT_URL = directUrl;

  const cleanupFile = resolveProjectPath("packages/shared/scripts/cleanup.sql");

  console.log("[pglite] applying embedded Postgres migrations");

  const migrationState = await getEmbeddedPrismaMigrationState();
  if (shouldBaselineEmbeddedPrismaMigrations(migrationState)) {
    await baselineEmbeddedPrismaMigrationHistory();
  }

  await applyEmbeddedMigrations();

  const cleanupSql = await readFile(cleanupFile, "utf8");
  await prisma.$executeRawUnsafe(cleanupSql);
};

export const runEmbeddedPglitePostgresMigrations = async (): Promise<void> => {
  globalThis.embeddedPglitePostgresMigrationPromise ??=
    runEmbeddedPglitePostgresMigrationsOnce().catch((error) => {
      globalThis.embeddedPglitePostgresMigrationPromise = undefined;
      throw error;
    });

  return globalThis.embeddedPglitePostgresMigrationPromise;
};
