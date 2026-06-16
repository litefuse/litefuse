jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
}));

jest.mock("node:fs/promises", () => ({
  readdir: jest.fn(),
  readFile: jest.fn(),
}));

const mockPgliteClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};

jest.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  },
  Client: jest.fn(() => mockPgliteClient),
}));

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { prisma, Client } from "@langfuse/shared/src/db";
import { runEmbeddedPglitePostgresMigrations } from "@/src/server/pglite/embeddedPglitePostgresMigrations";

const mockExistsSync = jest.mocked(existsSync);
const mockReaddir = jest.mocked(readdir);
const mockReadFile = jest.mocked(readFile);
const mockClientConstructor = jest.mocked(Client);
const mockQueryRawUnsafe = jest.mocked(prisma.$queryRawUnsafe);
const mockExecuteRawUnsafe = jest.mocked(prisma.$executeRawUnsafe);

describe("runEmbeddedPglitePostgresMigrations", () => {
  const originalDirectUrl = process.env.DIRECT_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAutoMigrationDisabled =
    process.env.LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED;

  beforeEach(() => {
    delete (
      globalThis as typeof globalThis & {
        embeddedPglitePostgresMigrationPromise?: Promise<void>;
      }
    ).embeddedPglitePostgresMigrationPromise;

    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@127.0.0.1:55432/postgres";
    delete process.env.DIRECT_URL;
    delete process.env.LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED;
    mockQueryRawUnsafe.mockResolvedValue([
      {
        hasPrismaMigrationsTable: false,
        userTableCount: 0,
      },
    ] as never);
    mockReadFile.mockImplementation(async (path) => {
      if (String(path).endsWith("packages/shared/scripts/cleanup.sql")) {
        return "SELECT 1;";
      }

      throw new Error(`Unexpected readFile path in test: ${String(path)}`);
    });
    mockExecuteRawUnsafe.mockResolvedValue(1 as never);
    mockReaddir.mockResolvedValue([]);

    mockExistsSync.mockImplementation((path) => {
      const candidate = String(path);
      return (
        candidate.endsWith("packages/shared/scripts/cleanup.sql") ||
        candidate.endsWith("packages/shared/prisma/schema.prisma") ||
        candidate.endsWith("packages/shared/prisma/migrations")
      );
    });

    mockPgliteClient.connect.mockResolvedValue(undefined);
    mockPgliteClient.query.mockResolvedValue({ rows: [] });
    mockPgliteClient.end.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalDirectUrl === undefined) {
      delete process.env.DIRECT_URL;
    } else {
      process.env.DIRECT_URL = originalDirectUrl;
    }

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalAutoMigrationDisabled === undefined) {
      delete process.env.LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED;
    } else {
      process.env.LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED =
        originalAutoMigrationDisabled;
    }

    mockExistsSync.mockReset();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockClientConstructor.mockClear();
    mockPgliteClient.connect.mockReset();
    mockPgliteClient.query.mockReset();
    mockPgliteClient.end.mockReset();
    mockQueryRawUnsafe.mockReset();
    mockExecuteRawUnsafe.mockReset();
  });

  it("applies pending prisma migrations through the embedded pglite client", async () => {
    mockQueryRawUnsafe
      .mockResolvedValueOnce([
        {
          hasPrismaMigrationsTable: false,
          userTableCount: 0,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);
    mockReaddir.mockResolvedValueOnce([
      {
        name: "20240101000000_init",
        isDirectory: () => true,
      },
    ] as never);
    mockReadFile.mockImplementation(async (path) => {
      const candidate = String(path);

      if (candidate.endsWith("packages/shared/scripts/cleanup.sql")) {
        return "SELECT 1;";
      }

      if (candidate.endsWith("20240101000000_init/migration.sql")) {
        return "CREATE TABLE test_table ();";
      }

      throw new Error(`Unexpected readFile path in test: ${candidate}`);
    });

    await runEmbeddedPglitePostgresMigrations();

    expect(mockClientConstructor).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 55432,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    expect(mockPgliteClient.connect).toHaveBeenCalledTimes(1);
    expect(mockPgliteClient.query).toHaveBeenCalledWith(
      "CREATE TABLE test_table ();",
    );
    expect(mockPgliteClient.end).toHaveBeenCalledTimes(1);
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("20240101000000_init"),
    );
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith("SELECT 1;");
    expect(process.env.DIRECT_URL).toBe(
      "postgresql://postgres:postgres@127.0.0.1:55432/postgres",
    );
  });

  it("baselines prisma migration history before deploy when embedded pglite already has tables", async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        hasPrismaMigrationsTable: false,
        userTableCount: 64,
      },
    ] as never);
    mockReaddir.mockResolvedValueOnce([
      {
        name: "20230518191501_init",
        isDirectory: () => true,
      },
      {
        name: "20230518193415_add_observaionts_and_traces",
        isDirectory: () => true,
      },
    ] as never);
    mockReadFile.mockImplementation(async (path) => {
      const candidate = String(path);

      if (candidate.endsWith("packages/shared/scripts/cleanup.sql")) {
        return "SELECT 1;";
      }

      if (candidate.endsWith("20230518191501_init/migration.sql")) {
        return "CREATE TABLE first_table ();";
      }

      if (
        candidate.endsWith(
          "20230518193415_add_observaionts_and_traces/migration.sql",
        )
      ) {
        return "CREATE TABLE second_table ();";
      }

      throw new Error(`Unexpected readFile path in test: ${candidate}`);
    });

    await runEmbeddedPglitePostgresMigrations();

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(
        'CREATE TABLE IF NOT EXISTS "_prisma_migrations"',
      ),
    );
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "_prisma_migrations"'),
    );
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("20230518191501_init"),
    );
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith("SELECT 1;");
    expect(mockClientConstructor).not.toHaveBeenCalled();
  });

  it("skips embedded postgres migrations when explicitly disabled", async () => {
    process.env.LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED = "true";

    await runEmbeddedPglitePostgresMigrations();

    expect(mockClientConstructor).not.toHaveBeenCalled();
  });
});
