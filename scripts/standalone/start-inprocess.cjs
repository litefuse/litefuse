#!/usr/bin/env node
/*
 * litefuse single-process launcher (in-process Doris).
 *
 * Boots the Next dev server with DYLD_INSERT_LIBRARIES pointed at the JDK's
 * libjsig.dylib so the in-process HotSpot JVM (embedded Doris) and V8 chain
 * their SIGSEGV handlers instead of clobbering each other.
 *
 * Why a node launcher (not `DYLD_INSERT_LIBRARIES=… pnpm dev:web`): macOS SIP
 * strips DYLD_* whenever a protected system binary (/bin/bash, /bin/sh) is in
 * the launch chain. `pnpm`, `npx` and `dotenv-cli` all shell out, so the var is
 * gone before node sees it. node carries the `allow-dyld-environment-variables`
 * entitlement, so node→node spawns DO propagate DYLD_*. This launcher therefore
 * avoids every shell hop: it loads .env via the dotenv *library* (no subprocess)
 * and spawns the next bin directly with node, so libjsig reaches the
 * next-server worker where instrumentation starts Doris.
 *
 * Dev launcher only (runs `next dev`/`next start` from the repo) — NOT bundled
 * into the standalone release; the release uses scripts/standalone/start.cjs.
 *
 * Usage: node scripts/standalone/start-inprocess.cjs   (requires LITEFUSE_EMBEDDED_DORIS_INPROCESS=true)
 */
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..", ".."); // scripts/standalone -> repo root
const webDir = path.join(root, "web");

// Parse .env inline (no dotenv-cli / shell subprocess that would strip DYLD_*).
const dotenvVars = {};
for (const line of fs
  .readFileSync(path.join(root, ".env"), "utf8")
  .split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  dotenvVars[k] = v;
}

// Bundled JDK under DORIS_LITE_HOME/jdk (no system JDK dependency).
const dorisHome = process.env.DORIS_LITE_HOME || dotenvVars.DORIS_LITE_HOME;
const jdkHome =
  process.env.JAVA_HOME ||
  (dorisHome
    ? path.join(dorisHome, "jdk")
    : path.join(root, "doris", "jdk"));
const jsig = process.env.LIBJSIG || path.join(jdkHome, "lib", "libjsig.dylib");
if (!fs.existsSync(jsig)) {
  console.error(`[start-inprocess] libjsig not found: ${jsig}`);
  process.exit(1);
}

const nextBin = require.resolve("next/dist/bin/next", { paths: [webDir] });
// pnpm/npx normally prepend node_modules/.bin to PATH; since we spawn node
// directly we must add it ourselves so instrumentation's `prisma` (PGlite
// migrations) and other CLIs resolve.
const binPath = [
  path.join(webDir, "node_modules", ".bin"),
  path.join(root, "node_modules", ".bin"),
  process.env.PATH || "",
].join(":");
const env = {
  ...process.env,
  ...dotenvVars,
  PATH: binPath,
  DYLD_INSERT_LIBRARIES: jsig,
};

// `node scripts/start-inprocess.cjs [dev|start]` — dev (default) or production.
const mode = process.argv[2] === "start" ? "start" : "dev";
// Production next start: let the app own signal handling (matches package.json).
if (mode === "start") env.NEXT_MANUAL_SIG_HANDLE = "true";

console.log(`[start-inprocess] DYLD_INSERT_LIBRARIES=${jsig}`);
console.log(`[start-inprocess] node ${nextBin} ${mode}  (cwd=${webDir})`);

const child = cp.spawn(process.execPath, [nextBin, mode], {
  cwd: webDir,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
