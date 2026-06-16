#!/usr/bin/env node
/*
 * litefuse standalone single-process release (Next standalone + in-process Doris).
 *
 * Runs the Next standalone server (app/web/server.js) — no full node_modules.
 * PGlite migrations are applied at startup by Prisma Client (no prisma CLI
 * needed); the standalone @prisma/client query engine handles runtime queries.
 * JVM/V8 signal chaining; Doris home/native runtime point at the bundle.
 *
 * This file is the SOURCE; scripts/standalone/build.sh copies it into the
 * release dir's bin/. Runtime layout assumed: this file lives in <root>/bin/.
 *
 * Usage: node start.cjs   (normally invoked via bin/start.sh with bundled node)
 */
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, ".."); // this file lives in bin/
const APP = path.join(ROOT, "app");
const SERVER = path.join(APP, "web", "server.js");

// Parse bundled .env (no shell that would strip DYLD_*).
const envFile = {};
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    envFile[k] = v;
  }
}
const envOr = (key, fallback) => process.env[key] || envFile[key] || fallback;

// Self-contained bundled JDK — ignore any external JAVA_HOME so the release
// never depends on a system JDK (on Linux a shared host often has JAVA_HOME set
// to a system JDK, which would break the libjvm/libjsig pairing).
const isLinux = process.platform === "linux";
const jdk = path.join(ROOT, "doris", "jdk");
const jsig = path.join(jdk, "lib", isLinux ? "libjsig.so" : "libjsig.dylib");
if (!fs.existsSync(jsig)) {
  console.error(`[min] libjsig not found: ${jsig}`);
  process.exit(1);
}

// Platform-specific signal/loader env for in-process JVM + V8 coexistence. These
// must be present in the SPAWNED CHILD's env at process start: the dynamic
// loader reads LD_PRELOAD / LD_LIBRARY_PATH / GLIBC_TUNABLES (and macOS dyld
// reads DYLD_*) exactly once, so setting them later from embeddedDoris.ts is too
// late for the BE library's dlopen of libjvm.
const platformEnv = {};
if (isLinux) {
  // jemalloc preload → one allocator for the whole process (node + BE + JVM) so
  // a cross-allocator free during JVM init can't crash; libjsig → SIGSEGV
  // handler chaining between HotSpot and V8.
  const jemalloc = path.join(
    ROOT,
    "doris",
    "lib",
    "native",
    "libdoris_jemalloc_preload.so",
  );
  const preload = [jemalloc, jsig].filter((p) => fs.existsSync(p)).join(":");
  const hadoopNative = path.join(
    ROOT,
    "doris",
    "lib",
    "native",
    "hadoop_native",
  );
  Object.assign(platformEnv, {
    LD_PRELOAD: preload,
    // The BE .so is STATIC_TLS (~33KB initial-exec TLS); glibc needs a surplus
    // to carve it for every new thread. 64KB is safe — 1MB+ makes the JVM's
    // process-reaper / df threads fail with "unable to create native thread".
    GLIBC_TUNABLES: "glibc.rtld.optional_static_tls=65536",
    LD_LIBRARY_PATH: [
      path.join(jdk, "lib", "server"), // libjvm.so for the BE .so's DT_NEEDED
      path.join(jdk, "lib"),
      hadoopNative,
      "/usr/lib64",
      process.env.LD_LIBRARY_PATH || "",
    ]
      .filter(Boolean)
      .join(":"),
  });
} else {
  platformEnv.DYLD_INSERT_LIBRARIES = jsig;
}

const env = {
  ...process.env,
  ...envFile,
  NODE_ENV: "production",
  ...platformEnv,
  LITEFUSE_STANDALONE_ROOT: ROOT,
  JAVA_HOME: jdk,
  LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED: envOr(
    "LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED",
    "false",
  ),
  // embedded PGlite (migrations applied at startup by Prisma Client)
  LITEFUSE_EMBEDDED_PGLITE: "true",
  PGLITE_DATA_DIR: path.join(ROOT, "pglite"),
  // in-process Doris pointing at bundled runtime
  LITEFUSE_EMBEDDED_DORIS: "true",
  LITEFUSE_EMBEDDED_DORIS_INPROCESS: "true",
  DORIS_LITE_HOME: path.join(ROOT, "doris"),
  DORIS_FE_QUERY_PORT: envOr("DORIS_FE_QUERY_PORT", "9030"),
  DORIS_FE_HTTP_URL: envOr("DORIS_FE_HTTP_URL", "http://127.0.0.1:8030"),
  DORIS_DB: envOr("DORIS_DB", "litefuse"),
  DORIS_USER: envOr("DORIS_USER", "root"),
  DORIS_PASSWORD: envOr("DORIS_PASSWORD", ""),
  // Single-node is the events-table architecture, so the v2 query APIs
  // (/api/public/v2/metrics, /v2/observations) must be enabled — they are
  // otherwise gated to Langfuse Cloud and 404 "v2 APIs ... only available on
  // Langfuse Cloud".
  LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS: "true",
  PORT: envOr("PORT", "3000"),
  // Use LITEFUSE_HOST to avoid clashing with CentOS' system HOSTNAME env var
  // which would resolve to 127.0.0.1 and make the service unreachable externally.
  HOSTNAME: envOr("LITEFUSE_HOST", "0.0.0.0"),
};

// --------------------------------------------------------------------------
// Central memory config (single source = .env). Three components share this
// one node process; each "limit" has different precision (see README):
//   - LITEFUSE_NODE_MEM_LIMIT -> node --max-old-space-size (V8 old-space only)
//   - LITEFUSE_JVM_MEM_LIMIT  -> Doris FE in-JVM -Xmx ( -Xms = 50% ), hard heap
//   - BE mem_limit            -> be.conf, statistically the WHOLE-process RSS,
//                                so it equals LITEFUSE_MEM_LIMIT (merged)
// If only LITEFUSE_MEM_LIMIT is set: NODE=50%, JVM=25%, BE=total.
const parseBytes = (s) => {
  if (!s) return null;
  const m = String(s)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([gmk]?)b?$/i);
  if (!m) return null;
  const mult =
    { g: 2 ** 30, k: 2 ** 10 }[m[2].toLowerCase()] ?? 2 ** 20; // ''/'m' => MiB
  return Math.round(parseFloat(m[1]) * mult);
};
const toMB = (b) => Math.max(64, Math.round(b / 2 ** 20));
const toJvm = (b) => `${toMB(b)}m`;

const total = parseBytes(env.LITEFUSE_MEM_LIMIT);
const nodeBytes =
  parseBytes(env.LITEFUSE_NODE_MEM_LIMIT) ??
  (total ? Math.round(total * 0.5) : parseBytes("1g"));
const jvmBytes =
  parseBytes(env.LITEFUSE_JVM_MEM_LIMIT) ??
  (total ? Math.round(total * 0.25) : parseBytes("512m"));
const beBytes = total ?? parseBytes("2g"); // BE == whole-process budget

// FE in-JVM heap -> internal env names read by embeddedDoris.ts / managedDoris.ts.
env.DORIS_LITE_FE_MAX_HEAP = toJvm(jvmBytes);
env.DORIS_LITE_FE_MIN_HEAP = toJvm(Math.round(jvmBytes * 0.5));
// BE mem_limit -> internal env name interpolated by doris/conf/be.conf.
env.DORIS_LITE_BE_MEM_LIMIT = toJvm(beBytes);

// const nodeArgs = [`--max-old-space-size=${toMB(nodeBytes)}`, SERVER];
const nodeArgs = [                                                                                                                                                                                   
  `--max-old-space-size=${toMB(nodeBytes)}`,           
  // dump .heapsnapshot to cwd (app/web/) when OOM occured, review in Chrome DevTools 
  `--heapsnapshot-near-heap-limit=1`,                                                                                                                                                                
  // Node diagnostic report：fatal error / write JSON，contains GC stats、heap spaces、libuv handles、native stack
  `--report-on-fatalerror`,                                                                                                                                                                          
  `--report-on-signal`,                                                                                                                                                                              
  `--report-signal=SIGUSR2`,                                                                                                                                                                         
  `--report-directory=${path.join(ROOT, "log")}`,                                                                                                                                                    
  `--report-filename=report-{pid}-{timestamp}-{ondemand}.json`,                                                                                                                                      
  SERVER,                                                                                                                                                                                            
];


console.log(`[min] root=${ROOT} platform=${process.platform}`);
if (isLinux) console.log(`[min] LD_PRELOAD=${platformEnv.LD_PRELOAD}`);
console.log(
  `[min] mem: total=${env.LITEFUSE_MEM_LIMIT || "(unset)"} | ` +
    `node(V8 old-space)=${toMB(nodeBytes)}m | ` +
    `jvm(-Xmx/-Xms)=${env.DORIS_LITE_FE_MAX_HEAP}/${env.DORIS_LITE_FE_MIN_HEAP} | ` +
    `be(mem_limit,whole-proc)=${env.DORIS_LITE_BE_MEM_LIMIT}`,
);
console.log(`[min] node ${nodeArgs.join(" ")}`);

const child = cp.spawn(process.execPath, nodeArgs, {
  cwd: path.join(APP, "web"),
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
