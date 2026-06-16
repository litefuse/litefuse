#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const APP_SHARED_DIR = path.join(ROOT, "app", "packages", "shared");
const APP_NODE_MODULES = path.join(ROOT, "app", "node_modules");

const loadMysql = () => {
  const directCandidates = [
    path.join(APP_NODE_MODULES, "mysql2", "promise"),
    path.join(APP_NODE_MODULES, "mysql2", "promise.js"),
  ];

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  const pnpmRoot = path.join(APP_NODE_MODULES, ".pnpm");
  if (!fs.existsSync(pnpmRoot)) {
    throw new Error(
      `mysql2 runtime dependency not found: missing ${pnpmRoot}`,
    );
  }

  const mysqlPkgDir = fs
    .readdirSync(pnpmRoot)
    .filter((entry) => entry.startsWith("mysql2@"))
    .sort()
    .at(-1);

  if (!mysqlPkgDir) {
    throw new Error(`mysql2 runtime dependency not found under ${pnpmRoot}`);
  }

  return require(
    path.join(
      pnpmRoot,
      mysqlPkgDir,
      "node_modules",
      "mysql2",
      "promise",
    ),
  );
};

const mysql = loadMysql();

const MIGRATIONS_DIR = path.join(APP_SHARED_DIR, "doris", "migrations");
const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";
const command = process.argv[2] || "up";

const parseDorisConfig = () => {
  const feHttpUrl = process.env.DORIS_FE_HTTP_URL || "http://127.0.0.1:8030";
  const url = new URL(feHttpUrl);

  return {
    host: url.hostname,
    port: Number(process.env.DORIS_FE_QUERY_PORT || "9030"),
    user: process.env.DORIS_USER || "root",
    password: process.env.DORIS_PASSWORD || "",
    database: process.env.DORIS_DB || "litefuse",
    partitionRetentionDays:
      process.env.LITEFUSE_DORIS_PARTITION_RETENTION_DAYS || "",
  };
};

const getConnection = async (withDatabase = false) => {
  const config = parseDorisConfig();
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: withDatabase ? config.database : undefined,
    timezone: "Z",
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: true,
  });
};

const getCreateTableStmt = async (connection, tableName) => {
  const [rows] = await connection.query(`SHOW CREATE TABLE ${tableName}`);
  const row = rows[0];
  return row?.["Create Table"] || row?.["Create Materialized View"] || "";
};

const normalizePartitionRetention = (value) => {
  if (!value || /^(off|0)$/i.test(value)) {
    return "";
  }

  if (!/^\d+$/.test(value)) {
    return "__INVALID__";
  }

  return Number(value) > 0 ? value : "__INVALID__";
};

const applyPartitionRetention = async (
  connection,
  tableName,
  dateColumn,
  desiredRetention,
) => {
  const [rows] = await connection.query(`SHOW TABLES LIKE '${tableName}'`);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(
      `Skipping partition.retention_count update for ${tableName}: table does not exist.`,
    );
    return;
  }

  const createStmt = await getCreateTableStmt(connection, tableName);
  const normalizedCreateStmt = createStmt.replace(/\s+/g, " ").trim();
  const partitionPattern = new RegExp(
    String.raw`AUTO PARTITION BY RANGE\s*\(date_trunc\(` +
      "`" +
      dateColumn +
      "`" +
      String.raw`,\s*'day'\)\)`,
    "i",
  );
  if (!partitionPattern.test(normalizedCreateStmt)) {
    throw new Error(
      `${tableName} is not day-partitioned on ${dateColumn}; refusing to set partition.retention_count.`,
    );
  }

  const retentionMatch = normalizedCreateStmt.match(
    /"partition\.retention_count"\s*=\s*"([^"]*)"/i,
  );
  const currentRetention = retentionMatch?.[1] || "";

  if (!desiredRetention) {
    console.log(
      `Retention disabled for ${tableName}; leaving current partition.retention_count=${currentRetention || "<unset>"} unchanged.`,
    );
    return;
  }

  if (currentRetention === desiredRetention) {
    console.log(
      `Skipping partition.retention_count update for ${tableName}: already ${desiredRetention}.`,
    );
    return;
  }

  console.log(
    `Applying partition.retention_count=${desiredRetention} to ${tableName}...`,
  );
  await connection.query(
    `ALTER TABLE ${tableName} SET ("partition.retention_count" = "${desiredRetention}")`,
  );
};

const getMigrationFiles = (suffix) =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(suffix))
    .sort();

const ensureDatabase = async (connection, database) => {
  await connection.query(`CREATE DATABASE IF NOT EXISTS ${database}`);
};

const ensureSchemaMigrationsTable = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
      version varchar(255) NOT NULL,
      applied_at datetime DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=OLAP
    DUPLICATE KEY(version)
    DISTRIBUTED BY HASH(version) BUCKETS 1
    PROPERTIES (
      "replication_allocation" = "tag.location.default: 1"
    )
  `);
};

const getAppliedMigrations = async (connection) => {
  const [rows] = await connection.query(
    `SELECT version FROM ${SCHEMA_MIGRATIONS_TABLE}`,
  );
  return new Set(rows.map((row) => row.version));
};

const markMigrationApplied = async (connection, version) => {
  await connection.query(
    `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version) VALUES (?)`,
    [version],
  );
};

const removeMigrationRecord = async (connection, version) => {
  await connection.query(
    `DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE version = ?`,
    [version],
  );
};

const runUp = async () => {
  const config = parseDorisConfig();
  const admin = await getConnection(false);

  try {
    console.log(
      `Connecting to Doris at ${config.host}:${config.port} with database ${config.database}`,
    );
    await ensureDatabase(admin, config.database);
  } finally {
    await admin.end();
  }

  const connection = await getConnection(true);
  try {
    await ensureSchemaMigrationsTable(connection);

    const appliedMigrations = await getAppliedMigrations(connection);
    const migrationFiles = getMigrationFiles(".up.sql");

    for (const file of migrationFiles) {
      const version = file.replace(/\.up\.sql$/, "");
      if (appliedMigrations.has(version)) {
        console.log(`Migration ${version} already applied, skipping...`);
        continue;
      }

      console.log(`Applying migration ${version}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await connection.query(sql);
      await markMigrationApplied(connection, version);
      console.log(`Migration ${version} applied successfully`);
    }

    if (config.partitionRetentionDays) {
      const normalizedRetention = normalizePartitionRetention(
        config.partitionRetentionDays,
      );

      if (normalizedRetention === "__INVALID__") {
        throw new Error(
          "LITEFUSE_DORIS_PARTITION_RETENTION_DAYS must be a positive integer, 0, or off.",
        );
      }

      await applyPartitionRetention(
        connection,
        "events_full",
        "start_time_date",
        normalizedRetention,
      );
    }

    console.log("All migrations completed successfully!");
  } finally {
    await connection.end();
  }
};

const getLatestMigration = async (connection) => {
  const [rows] = await connection.query(
    `SELECT version FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY applied_at DESC LIMIT 1`,
  );
  return rows[0]?.version || null;
};

const runDown = async () => {
  const config = parseDorisConfig();
  const connection = await getConnection(true);

  try {
    const [tableRows] = await connection.query(
      `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = ?`,
      [config.database, SCHEMA_MIGRATIONS_TABLE],
    );

    if (!Number(tableRows[0]?.count || 0)) {
      console.log("Migration tracking table does not exist. Nothing to rollback.");
      return;
    }

    const latestMigration = await getLatestMigration(connection);
    if (!latestMigration) {
      console.log("No migrations found to rollback.");
      return;
    }

    const downFile = path.join(MIGRATIONS_DIR, `${latestMigration}.down.sql`);
    if (!fs.existsSync(downFile)) {
      throw new Error(`Down migration file not found: ${downFile}`);
    }

    console.log(`Rolling back migration: ${latestMigration}`);
    const sql = fs.readFileSync(downFile, "utf8");
    await connection.query(sql);
    await removeMigrationRecord(connection, latestMigration);
    console.log(`Migration ${latestMigration} rolled back successfully`);
  } finally {
    await connection.end();
  }
};

const listDropTargets = async (connection, database, tableType) => {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ?
       AND TABLE_TYPE = ?`,
    [database, tableType],
  );

  return rows.map((row) => row.TABLE_NAME);
};

const runDrop = async () => {
  const config = parseDorisConfig();
  const connection = await getConnection(true);

  try {
    const views = await listDropTargets(connection, config.database, "VIEW");
    for (const view of views) {
      console.log(`Dropping view: ${view}`);
      await connection.query(`DROP VIEW IF EXISTS \`${view}\``);
    }

    const tables = await listDropTargets(connection, config.database, "BASE TABLE");
    for (const table of tables) {
      console.log(`Dropping table: ${table}`);
      await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    }

    console.log(
      `Database ${config.database} is now empty and ready for fresh migrations.`,
    );
  } finally {
    await connection.end();
  }
};

const main = async () => {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  if (command === "up") {
    await runUp();
    return;
  }

  if (command === "down") {
    await runDown();
    return;
  }

  if (command === "drop") {
    await runDrop();
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
};

main().catch((error) => {
  console.error(
    `[doris] migration command failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
