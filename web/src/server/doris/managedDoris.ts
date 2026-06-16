// Managed Apache Doris child process for single-node litefuse.
//
// litefuse spawns a standalone single-process Doris (BE + in-JVM FE, via the
// doris_be binary with enable_fe_in_process=true) as a CHILD process, then
// supervises it: it health-checks the FE over the MySQL wire protocol and
// auto-restarts the child if it dies or stops responding. This is the
// out-of-process counterpart to embedded PGlite — litefuse owns Doris's
// lifecycle without sharing its address space.
//
// Why a child process rather than in-process embedding: Doris's BE drags in a
// HotSpot JVM and gperftools tcmalloc. Co-residing those with V8 in one process
// fails on macOS two ways — V8 and HotSpot both install SIGSEGV handlers
// (implicit null-checks / WASM traps) that clobber each other, and tcmalloc
// (which does not register as a macOS malloc zone) aborts when it sees a
// pointer from libsystem's heap. Running Doris as its own process sidesteps
// both: it gets its own signal handlers and its own primary allocator.
//
// Started from instrumentation.ts after embedded PGlite, before init scripts.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

declare global {
  var managedDorisStartPromise: Promise<void> | undefined;
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

interface DorisSupervisorConfig {
  binary: string;
  dorisHome: string;
  javaHome: string;
  beLib: string;
  feLib: string;
  feHttpUrl: string;
  feQueryPort: number;
  user: string;
  password: string;
  // First-boot readiness wait (after which litefuse continues regardless).
  readyTimeoutMs: number;
  // Health-check cadence and the number of consecutive failures that trigger a
  // forced restart of a hung (alive but unresponsive) child.
  healthIntervalMs: number;
  healthFailuresToRestart: number;
  // Restart backoff bounds.
  restartBackoffMinMs: number;
  restartBackoffMaxMs: number;
  // Max time a freshly-spawned child may take to first answer SELECT 1 before
  // it is considered a stuck startup and force-restarted.
  startupBudgetMs: number;
}

class DorisSupervisor {
  private readonly cfg: DorisSupervisorConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logStream: fs.WriteStream;

  private child: ChildProcess | null = null;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private consecutiveBackoffs = 0;
  private consecutiveHealthFailures = 0;
  private healthCheckInFlight = false;
  private restartCount = 0;
  // Per-child startup tracking. Doris (BE + FE JVM) can take a minute to answer
  // queries; we must NOT mistake a slow-but-healthy startup for a hang. So the
  // forced-restart-on-health-failure logic only applies once a child has been
  // ready at least once; before that we only enforce a generous startup budget.
  private childStartedAt = 0;
  private childEverReady = false;

  // Resolves once the FE first answers SELECT 1 (or the boot wait times out).
  private firstReady: Promise<void>;
  private signalFirstReady!: () => void;

  constructor(cfg: DorisSupervisorConfig) {
    this.cfg = cfg;
    this.env = this.buildEnv();
    fs.mkdirSync(path.join(cfg.dorisHome, "log"), { recursive: true });
    this.logStream = fs.createWriteStream(
      path.join(cfg.dorisHome, "log", "doris-managed.out"),
      { flags: "a" },
    );
    this.firstReady = new Promise<void>((resolve) => {
      this.signalFirstReady = resolve;
    });
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const { dorisHome, javaHome, beLib, feLib } = this.cfg;
    const jars = collectJars([path.join(dorisHome, "lib"), feLib, beLib]);
    if (jars.length === 0) {
      throw new Error(
        `[doris] no jars found under ${dorisHome}/lib, ${feLib} or ${beLib}`,
      );
    }
    const jvmLibs = `${javaHome}/lib/server:${javaHome}/lib`;
    const logDir = path.join(dorisHome, "log");
    const javaOpts = [
      "-Dfile.encoding=UTF-8",
      // FE/in-JVM heap — centrally configurable (see bin/start.cjs / .env).
      `-Xmx${process.env.DORIS_LITE_FE_MAX_HEAP || "512m"}`,
      `-Xms${process.env.DORIS_LITE_FE_MIN_HEAP || "256m"}`,
      `-DlogPath=${logDir}/jni.log`,
      "-Dsun.java.command=DorisLite",
      "-XX:-CriticalJNINatives",
      "-XX:-MaxFDLimit",
      "-XX:+IgnoreUnrecognizedVMOptions",
      "-Djavax.security.auth.useSubjectCredsOnly=false",
      "-Darrow.enable_null_check_for_get=false",
      ...ADD_OPENS.map((o) => `--add-opens=${o}=ALL-UNNAMED`),
    ].join(" ");

    // A fresh env (not litefuse's process.env) so Doris's own DORIS_HOME /
    // JAVA_OPTS / classpath never leak back into the litefuse process. We do
    // NOT set DORIS_LITE_EMBED: as its own process, Doris should install its
    // normal signal handlers and own its lifecycle.
    return {
      PATH: process.env.PATH,
      DORIS_HOME: dorisHome,
      PID_DIR: path.join(dorisHome, "bin"),
      LOG_DIR: logDir,
      JAVA_HOME: javaHome,
      DYLD_LIBRARY_PATH: jvmLibs,
      LD_LIBRARY_PATH: jvmLibs,
      DORIS_CLASSPATH: `-Djava.class.path=${jars.join(":")}`,
      JAVA_OPTS: javaOpts,
      // Cast: litefuse augments NodeJS.ProcessEnv with required keys (NODE_ENV
      // etc.), but this is a deliberately minimal env handed only to the Doris
      // child — not litefuse's own process env.
    } as unknown as NodeJS.ProcessEnv;
  }

  start(): void {
    for (const sub of ["log", "storage", "doris-meta", "bin"]) {
      fs.mkdirSync(path.join(this.cfg.dorisHome, sub), { recursive: true });
    }
    this.spawnChild();
    this.healthTimer = setInterval(
      () => void this.runHealthCheck(),
      this.cfg.healthIntervalMs,
    );
    if (typeof this.healthTimer.unref === "function") this.healthTimer.unref();

    const shutdown = () => this.shutdown();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  waitFirstReady(): Promise<void> {
    return this.firstReady;
  }

  private spawnChild(): void {
    if (this.shuttingDown) return;
    const { binary, dorisHome } = this.cfg;
    console.log(
      `[doris] launching Doris child (binary=${binary}, home=${dorisHome})` +
        (this.restartCount > 0 ? ` [restart #${this.restartCount}]` : ""),
    );

    const child = spawn(binary, [], {
      env: this.env,
      cwd: dorisHome,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.childStartedAt = Date.now();
    this.childEverReady = false;
    this.consecutiveHealthFailures = 0;

    child.stdout?.pipe(this.logStream, { end: false });
    child.stderr?.pipe(this.logStream, { end: false });

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.shuttingDown) return;
      console.error(
        `[doris] child exited (code=${code}, signal=${signal}); scheduling restart`,
      );
      this.scheduleRestart();
    });
    child.on("error", (err) => {
      console.error(`[doris] child spawn error: ${err.message}`);
    });
  }

  private scheduleRestart(): void {
    if (this.shuttingDown || this.restartTimer) return;
    const delay = Math.min(
      this.cfg.restartBackoffMinMs * 2 ** this.consecutiveBackoffs,
      this.cfg.restartBackoffMaxMs,
    );
    this.consecutiveBackoffs++;
    this.restartCount++;
    console.log(`[doris] restarting child in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.consecutiveHealthFailures = 0;
      this.spawnChild();
    }, delay);
    if (typeof this.restartTimer.unref === "function")
      this.restartTimer.unref();
  }

  private async runHealthCheck(): Promise<void> {
    if (this.shuttingDown || this.healthCheckInFlight) return;
    if (!this.child) return; // mid-restart; nothing to probe
    this.healthCheckInFlight = true;
    try {
      const ok = await this.probeOnce();
      if (ok) {
        if (
          this.consecutiveHealthFailures > 0 ||
          this.consecutiveBackoffs > 0
        ) {
          console.log("[doris] health restored");
        }
        this.childEverReady = true;
        this.consecutiveHealthFailures = 0;
        this.consecutiveBackoffs = 0; // sustained health resets backoff
        this.signalFirstReady();
        return;
      }
      if (!this.child) return;
      if (!this.childEverReady) {
        // Still starting up — a slow boot is normal (BE recovery + FE JVM).
        // Only force a restart if it blows the startup budget entirely, so we
        // never SIGKILL a healthy-but-slow boot (which would loop forever).
        if (Date.now() - this.childStartedAt > this.cfg.startupBudgetMs) {
          console.error(
            `[doris] child did not become ready within ` +
              `${this.cfg.startupBudgetMs}ms; force-restarting`,
          );
          this.child.kill("SIGKILL");
        }
        return;
      }
      // The child was ready before and is now failing — treat as a hang or
      // regression and force-restart after a few consecutive failures.
      this.consecutiveHealthFailures++;
      if (this.consecutiveHealthFailures >= this.cfg.healthFailuresToRestart) {
        console.error(
          `[doris] ${this.consecutiveHealthFailures} consecutive health ` +
            `failures after being ready; killing child to force restart`,
        );
        // SIGKILL: a hung BE/JVM may ignore SIGTERM. The 'exit' handler
        // schedules the restart.
        this.child.kill("SIGKILL");
      }
    } finally {
      this.healthCheckInFlight = false;
    }
  }

  private async probeOnce(): Promise<boolean> {
    const { DorisClient } = await import("@langfuse/shared/src/server");
    const client = new DorisClient({
      feHttpUrl: this.cfg.feHttpUrl,
      feQueryPort: this.cfg.feQueryPort,
      database: "",
      username: this.cfg.user,
      password: this.cfg.password,
    });
    try {
      await client.query("SELECT 1");
      return true;
    } catch {
      return false;
    } finally {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
  }

  private shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    const child = this.child;
    if (!child) return;
    console.log("[doris] stopping Doris child");
    child.kill("SIGTERM");
    // Escalate to SIGKILL if it does not exit promptly.
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 15000);
    if (typeof killTimer.unref === "function") killTimer.unref();
  }
}

const requireEnv = (key: string): string => {
  const v = process.env[key];
  if (!v)
    throw new Error(
      `[doris] ${key} must be set (release: bin/start.cjs provides it; dev: set in .env)`,
    );
  return v;
};

const startManagedDorisOnce = async (): Promise<void> => {
  const dorisHome = requireEnv("DORIS_LITE_HOME");
  const cfg: DorisSupervisorConfig = {
    binary:
      process.env.DORIS_LITE_BIN ?? path.join(dorisHome, "lib", "doris_be"),
    dorisHome,
    javaHome: process.env.JAVA_HOME ?? path.join(dorisHome, "jdk"),
    beLib: requireEnv("DORIS_LITE_BE_LIB"),
    feLib: requireEnv("DORIS_LITE_FE_LIB"),
    feHttpUrl: process.env.DORIS_FE_HTTP_URL ?? "http://127.0.0.1:8130",
    feQueryPort: Number(process.env.DORIS_FE_QUERY_PORT ?? 9130),
    user: process.env.DORIS_USER ?? "root",
    password: process.env.DORIS_PASSWORD ?? "",
    readyTimeoutMs: Number(process.env.DORIS_LITE_READY_TIMEOUT_MS ?? 180000),
    healthIntervalMs: Number(process.env.DORIS_LITE_HEALTH_INTERVAL_MS ?? 5000),
    healthFailuresToRestart: Number(
      process.env.DORIS_LITE_HEALTH_FAILURES ?? 6,
    ),
    restartBackoffMinMs: 1000,
    restartBackoffMaxMs: 30000,
    startupBudgetMs: Number(process.env.DORIS_LITE_STARTUP_BUDGET_MS ?? 180000),
  };

  if (!fs.existsSync(cfg.binary)) {
    throw new Error(`[doris] doris_be binary not found: ${cfg.binary}`);
  }

  const supervisor = new DorisSupervisor(cfg);
  supervisor.start();

  // Wait for Doris to first become query-ready, but do not block litefuse
  // startup forever: if it overruns the boot timeout, continue — the supervisor
  // keeps (re)starting and health-checking in the background.
  const timeout = sleep(cfg.readyTimeoutMs).then(() => "timeout" as const);
  const winner = await Promise.race([
    supervisor.waitFirstReady().then(() => "ready" as const),
    timeout,
  ]);
  if (winner === "ready") {
    console.log(
      `[doris] Doris child ready (FE accepting queries on ${cfg.feQueryPort})`,
    );
  } else {
    console.warn(
      `[doris] Doris not ready within ${cfg.readyTimeoutMs}ms; continuing ` +
        `litefuse startup — supervisor will keep retrying`,
    );
  }
};

export const startManagedDoris = async (): Promise<void> => {
  globalThis.managedDorisStartPromise ??= startManagedDorisOnce();
  return globalThis.managedDorisStartPromise;
};
