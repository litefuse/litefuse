import { EventEmitter } from "node:events";

jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
}));

jest.mock("node:child_process", () => ({
  spawn: jest.fn(),
}));

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { runStandaloneDorisMigrations } from "@/src/server/doris/standaloneDorisMigrations";

const mockExistsSync = jest.mocked(existsSync);
const mockSpawn = jest.mocked(spawn);

describe("runStandaloneDorisMigrations", () => {
  const originalStandaloneRoot = process.env.LITEFUSE_STANDALONE_ROOT;
  const originalAutoMigrationDisabled =
    process.env.LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED;

  beforeEach(() => {
    delete (
      globalThis as typeof globalThis & {
        standaloneDorisMigrationPromise?: Promise<void>;
      }
    ).standaloneDorisMigrationPromise;

    process.env.LITEFUSE_STANDALONE_ROOT = "/tmp/litefuse-standalone";
    delete process.env.LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED;

    mockExistsSync.mockReturnValue(true);
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      setImmediate(() => {
        (child as unknown as EventEmitter).emit("exit", 0, null);
      });
      return child;
    });
  });

  afterEach(() => {
    if (originalStandaloneRoot === undefined) {
      delete process.env.LITEFUSE_STANDALONE_ROOT;
    } else {
      process.env.LITEFUSE_STANDALONE_ROOT = originalStandaloneRoot;
    }

    if (originalAutoMigrationDisabled === undefined) {
      delete process.env.LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED;
    } else {
      process.env.LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED =
        originalAutoMigrationDisabled;
    }

    mockExistsSync.mockReset();
    mockSpawn.mockReset();
  });

  it("runs the standalone Doris migration CLI when a release root is configured", async () => {
    await runStandaloneDorisMigrations();

    expect(mockExistsSync).toHaveBeenCalledWith(
      "/tmp/litefuse-standalone/bin/doris-migrations.cjs",
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/litefuse-standalone/bin/doris-migrations.cjs", "up"],
      expect.objectContaining({
        cwd: "/tmp/litefuse-standalone",
        stdio: "inherit",
        env: process.env,
      }),
    );
  });

  it("skips standalone Doris migrations when auto migration is disabled", async () => {
    process.env.LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED = "true";

    await runStandaloneDorisMigrations();

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips standalone Doris migrations outside the packaged release", async () => {
    delete process.env.LITEFUSE_STANDALONE_ROOT;

    await runStandaloneDorisMigrations();

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
