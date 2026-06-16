// See: https://vercel.com/docs/observability/otel-overview
export async function register() {
  // This variable is set in the .env file or environment variables
  // Value is true if NEXT_PUBLIC_LITEFUSE_RUN_NEXT_INIT is "true" or undefined
  const isInitLoadingEnabled =
    process.env.NEXT_PUBLIC_LITEFUSE_RUN_NEXT_INIT !== undefined
      ? process.env.NEXT_PUBLIC_LITEFUSE_RUN_NEXT_INIT === "true"
      : true;

  // Start the embedded PGlite server before anything touches the database, so
  // Prisma, pg-boss and the shared pg Pool can connect over loopback. This is
  // the database itself, not an init script — it must come up whenever the
  // node runtime boots, independent of NEXT_PUBLIC_LITEFUSE_RUN_NEXT_INIT.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.LITEFUSE_EMBEDDED_PGLITE === "true"
  ) {
    const { startEmbeddedPglite } = await import(
      "./server/pglite/embeddedPglite"
    );
    const { runEmbeddedPglitePostgresMigrations } = await import(
      "./server/pglite/embeddedPglitePostgresMigrations"
    );
    await startEmbeddedPglite();
    await runEmbeddedPglitePostgresMigrations();
  }

  // Bring up Apache Doris (BE + in-JVM FE) before any analytics DB access. Two
  // modes, selected by LITEFUSE_EMBEDDED_DORIS_INPROCESS:
  //   - in-process: Doris runs inside this node process via the dorisembed
  //     addon (one OS process; requires libjsig preloaded — see embeddedDoris.ts)
  //   - managed (default): litefuse spawns & supervises Doris as a child process
  // Either way no external Doris cluster is needed for single-node. The
  // in-process variant is order-independent for crashes (jemalloc tolerates the
  // cross-heap frees during JVM init); PGlite-first is the natural order so the
  // primary DB is ready first.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.LITEFUSE_EMBEDDED_DORIS === "true"
  ) {
    if (process.env.LITEFUSE_EMBEDDED_DORIS_INPROCESS === "true") {
      const { startEmbeddedDoris } = await import(
        "./server/doris/embeddedDoris"
      );
      await startEmbeddedDoris();
    } else {
      const { startManagedDoris } = await import("./server/doris/managedDoris");
      await startManagedDoris();
    }

    const { runStandaloneDorisMigrations } = await import(
      "./server/doris/standaloneDorisMigrations"
    );
    await runStandaloneDorisMigrations();
  }

  if (process.env.NEXT_RUNTIME === "nodejs" && isInitLoadingEnabled) {
    console.log("Running init scripts...");
    await import("./observability.config");
    await import("./initialize");
    const { startBackgroundProcessing } = await import(
      "./server/background/bootstrap"
    );
    startBackgroundProcessing();
  }
}
