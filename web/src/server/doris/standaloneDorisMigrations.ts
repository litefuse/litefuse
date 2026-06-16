import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

declare global {
  var standaloneDorisMigrationPromise: Promise<void> | undefined;
}

const runCommand = async (
  command: string,
  args: string[],
  cwd: string,
): Promise<void> => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with code ${
            code ?? "unknown"
          }${signal ? ` (signal ${signal})` : ""}`,
        ),
      );
    });
  });
};

const runStandaloneDorisMigrationsOnce = async (): Promise<void> => {
  if (process.env.LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED === "true") {
    return;
  }

  const standaloneRoot = process.env.LITEFUSE_STANDALONE_ROOT;
  if (!standaloneRoot) {
    return;
  }

  const migrationScript = resolve(
    standaloneRoot,
    "bin",
    "doris-migrations.cjs",
  );
  if (!existsSync(migrationScript)) {
    throw new Error(
      `[doris] standalone migration script not found: ${migrationScript}`,
    );
  }

  console.log("[doris] applying standalone Doris migrations");
  await runCommand(process.execPath, [migrationScript, "up"], standaloneRoot);
  console.log("[doris] standalone Doris migrations complete");
};

export const runStandaloneDorisMigrations = async (): Promise<void> => {
  globalThis.standaloneDorisMigrationPromise ??=
    runStandaloneDorisMigrationsOnce();

  try {
    await globalThis.standaloneDorisMigrationPromise;
  } catch (error) {
    globalThis.standaloneDorisMigrationPromise = undefined;
    throw error;
  }
};
