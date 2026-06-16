// In-process (single-process) Apache Doris for single-node litefuse.
//
// Runs Doris (BE + in-JVM FE) INSIDE the litefuse web process via the
// `dorisembed` N-API addon, which dlopen()s libdoris_be.dylib and runs the BE's
// exported doris_be_run() on a dedicated pthread. This is the "everything in one
// OS process" variant of the managed-child-process supervisor (managedDoris.ts);
// pick one via LITEFUSE_EMBEDDED_DORIS_INPROCESS.
//
// REQUIREMENTS for this to be stable (learned the hard way):
//   1. libjsig signal chaining MUST be preloaded at node launch:
//        DYLD_INSERT_LIBRARIES=$JAVA_HOME/lib/libjsig.dylib
//      V8 and the HotSpot JVM both install SIGSEGV handlers (V8 WASM traps /
//      HotSpot implicit null-checks). Without libjsig they clobber each other
//      and the JVM's recoverable segfaults crash the process. libjsig chains
//      them. This env var is read by dyld at process start, so it cannot be set
//      from inside this module — the launcher must set it.
//   2. DORIS_LITE_EMBED=1 makes the BE skip its glog signal handlers,
//      init_signals() and _exit(), ceding process lifecycle to the node host.
//   3. JAVA_OPTS must include -Xrs so the in-process JVM cedes
//      SIGINT/SIGTERM/SIGHUP to the node host.
//
// Shutdown contract: host calls addon.stop() then exits the process. We do NOT
// pthread_join the BE thread — embedded mode returns from doris_be_run() rather
// than _exit(), and waiting on the C++ destructor unwind is unsafe. For a
// single-node deployment "stop" == "process exits", so this is benign.

import fs from "fs";
import path from "path";

declare global {
  var embeddedDorisStartPromise: Promise<void> | undefined;
}

// JDK17 module-opens the in-JVM FE needs (mirrors run_dorislite.sh).
const ADD_OPENS = [
  "java.base/java.lang",
  "java.base/java.lang.invoke",
  "java.base/java.lang.reflect",
  "java.base/java.io",
  "java.base/java.net",
  "java.base/java.nio",
  "java.base/java.util",
  "java.base/java.util.concurrent",
  "java.base/java.util.concurrent.atomic",
  "java.base/sun.nio.ch",
  "java.base/sun.nio.cs",
  "java.base/sun.security.action",
  "java.base/sun.util.calendar",
  "java.security.jgss/sun.security.krb5",
  "java.management/sun.management",
  "java.base/jdk.internal.ref",
  "java.xml/com.sun.org.apache.xerces.internal.jaxp",
];

interface DorisEmbedAddon {
  start(dylibPath: string): boolean;
  stop(): void;
  join(): void;
}

const collectJars = (dirs: string[]): string[] => {
  const jars: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".jar")) jars.push(full);
    }
  };
  for (const d of dirs) walk(d);
  return jars;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const requireEnv = (key: string): string => {
  const v = process.env[key];
  if (!v)
    throw new Error(
      `[doris] ${key} must be set (release: bin/start.cjs provides it; dev: set in .env)`,
    );
  return v;
};

const resolveAddonPath = (dorisHome: string): string => {
  const standaloneRoot = process.env.LITEFUSE_STANDALONE_ROOT
    ? path.resolve(process.env.LITEFUSE_STANDALONE_ROOT)
    : path.resolve(dorisHome, "..");
  const standaloneAddon = path.join(
    standaloneRoot,
    "native",
    "doris_lite_embed.node",
  );
  if (fs.existsSync(standaloneAddon)) {
    return standaloneAddon;
  }

  // Dev fallback: node-gyp rebuild under web/src/server/doris/native.
  return path.resolve(
    process.cwd(),
    "src/server/doris/native/build/Release/doris_lite_embed.node",
  );
};

const resolveDylibPath = (dorisHome: string): string =>
  path.join(
    dorisHome,
    "lib",
    "native",
    `libdoris_lite.${process.platform === "linux" ? "so" : "dylib"}`,
  );

const startEmbeddedDorisOnce = async (): Promise<void> => {
  // Self-contained single-process home (output/doris_lite): conf has
  // enable_fe_in_process=true + fe_lib_dir=${DORIS_HOME}/lib, and lib/ holds all
  // FE+BE jars and java_extensions. Mirrors bin/start.sh.
  const dorisHome = requireEnv("DORIS_LITE_HOME");
  const addonPath = resolveAddonPath(dorisHome);
  const dylibPath = resolveDylibPath(dorisHome);
  // Bundled JDK (DORIS_LITE_HOME/jdk); the dylib's libjvm install_name points
  // into this same JDK, so libjsig must come from here too.
  const javaHome = process.env.JAVA_HOME ?? path.join(dorisHome, "jdk");

  const feQueryPort = Number(process.env.DORIS_FE_QUERY_PORT ?? 9030);
  const feHttpUrl = process.env.DORIS_FE_HTTP_URL ?? "http://127.0.0.1:8030";
  const probeUser = process.env.DORIS_USER ?? "root";
  const probePassword = process.env.DORIS_PASSWORD ?? "";
  const readyTimeoutMs = Number(
    process.env.DORIS_LITE_READY_TIMEOUT_MS ?? 240000,
  );

  for (const [label, p] of [
    ["addon", addonPath],
    ["dylib", dylibPath],
  ] as const) {
    if (!fs.existsSync(p)) {
      throw new Error(`[doris] embedded ${label} not found: ${p}`);
    }
  }

  // Warn loudly if libjsig was not preloaded — without it the in-process JVM and
  // V8 will fight over SIGSEGV and the process will crash under load. The
  // preload env differs by platform (Linux LD_PRELOAD, macOS DYLD_*).
  const isLinux = process.platform === "linux";
  const preloadVar =
    (isLinux ? process.env.LD_PRELOAD : process.env.DYLD_INSERT_LIBRARIES) ??
    "";
  if (!/libjsig/.test(preloadVar)) {
    const how = isLinux
      ? "LD_PRELOAD=$JAVA_HOME/lib/libjsig.so"
      : "DYLD_INSERT_LIBRARIES=$JAVA_HOME/lib/libjsig.dylib";
    console.warn(
      "[doris] WARNING: libjsig not preloaded — in-process Doris is likely to " +
        `crash (V8/JVM SIGSEGV handler conflict). Launch with ${how}`,
    );
  }

  const jars = collectJars([path.join(dorisHome, "lib")]);
  if (jars.length === 0) {
    throw new Error(`[doris] no jars found under ${dorisHome}/lib`);
  }

  const logDir = path.join(dorisHome, "log");
  const javaOpts = [
    "-Dfile.encoding=UTF-8",
    // FE/in-JVM heap — centrally configurable (see bin/start.cjs / .env).
    `-Xmx${process.env.DORIS_LITE_FE_MAX_HEAP || "512m"}`,
    `-Xms${process.env.DORIS_LITE_FE_MIN_HEAP || "256m"}`,
    "-Xrs", // cede SIGINT/SIGTERM/SIGHUP to the node host
    `-DlogPath=${logDir}/jni.log`,
    "-Dsun.java.command=DorisLite",
    "-XX:-CriticalJNINatives",
    "-XX:-MaxFDLimit",
    "-XX:+IgnoreUnrecognizedVMOptions",
    "-Djavax.security.auth.useSubjectCredsOnly=false",
    "-Darrow.enable_null_check_for_get=false",
    // Linux-only: the BE .so is STATIC_TLS, so every JVM thread carves its
    // initial-exec TLS block from its stack — give threads headroom and force
    // the process-reaper (spawned by DiskUtils.df → Runtime.exec) to use the
    // default (large) stack, else thread creation faults / "unable to create
    // native thread". (Harmless/ignored on macOS via IgnoreUnrecognizedVMOptions.)
    ...(isLinux
      ? [
          "-Djdk.lang.processReaperUseDefaultStackSize=true",
          "-Xss8m",
          "-XX:VMThreadStackSize=8192",
          "-XX:CompilerThreadStackSize=8192",
        ]
      : []),
    ...ADD_OPENS.map((o) => `--add-opens=${o}=ALL-UNNAMED`),
  ].join(" ");

  const jvmLibs = `${javaHome}/lib/server:${javaHome}/lib`;
  // The BE dylib reads DORIS_LITE_EMBED to enter embedded (in-process) mode.
  process.env.DORIS_LITE_EMBED = "1";
  process.env.DORIS_HOME = dorisHome;
  process.env.PID_DIR = path.join(dorisHome, "bin");
  process.env.LOG_DIR = logDir;
  process.env.JAVA_HOME = javaHome;
  process.env.DYLD_LIBRARY_PATH = process.env.DYLD_LIBRARY_PATH
    ? `${jvmLibs}:${process.env.DYLD_LIBRARY_PATH}`
    : jvmLibs;
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${jvmLibs}:${process.env.LD_LIBRARY_PATH}`
    : jvmLibs;
  const classpath = jars.join(":");
  process.env.DORIS_CLASSPATH = `-Djava.class.path=${classpath}`;
  process.env.CLASSPATH = classpath;
  process.env.JAVA_OPTS = javaOpts;
  process.env.LIBHDFS_OPTS = javaOpts;

  for (const sub of ["log", "storage", "doris-meta", "bin"]) {
    fs.mkdirSync(path.join(dorisHome, sub), { recursive: true });
  }

  // Non-analyzable require so the bundler does not try to resolve the absolute
  // .node path at build time.

  const nodeRequire = eval("require") as NodeRequire;
  const addon = nodeRequire(addonPath) as DorisEmbedAddon;

  console.log(
    `[doris] starting in-process Doris (home=${dorisHome}, jars=${jars.length}, ` +
      `queryPort=${feQueryPort})`,
  );
  addon.start(path.resolve(dylibPath));
  console.log(
    "[doris] addon.start() returned — BE run loop is on its own thread",
  );

  const { DorisClient } = await import("@langfuse/shared/src/server");
  const newClient = () =>
    new DorisClient({
      feHttpUrl,
      feQueryPort,
      database: "",
      username: probeUser,
      password: probePassword,
    });

  const deadline = Date.now() + readyTimeoutMs;
  let lastErr: unknown;
  let ready = false;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    const client = newClient();
    try {
      await client.query("SELECT 1");
      ready = true;
    } catch (err) {
      lastErr = err;
    } finally {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
    if (ready) break;
    if (attempt % 10 === 0) {
      console.log(
        `[doris] waiting for in-process FE on port ${feQueryPort} (attempt ${attempt})...`,
      );
    }
    await sleep(1000);
  }
  if (!ready) {
    throw new Error(
      `[doris] in-process Doris not ready within ${readyTimeoutMs}ms: ` +
        `${(lastErr as Error)?.message ?? lastErr}`,
    );
  }

  console.log(
    `[doris] in-process Doris ready (FE accepting queries on ${feQueryPort})`,
  );

  const shutdown = () => {
    try {
      addon.stop();
    } catch {
      // best-effort
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

export const startEmbeddedDoris = async (): Promise<void> => {
  globalThis.embeddedDorisStartPromise ??= startEmbeddedDorisOnce();
  return globalThis.embeddedDorisStartPromise;
};
