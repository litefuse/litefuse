# Building litefuse standalone on macOS (Apple Silicon)

How to build the single-process, self-contained litefuse release from scratch.
Two stages: **(A)** compile the in-process Doris native artifacts (dylib +
N-API addon), then **(B)** build the litefuse web app and assemble + pack the
release.

> Platform: **macOS arm64 only**. The release bundles a prebuilt Doris dylib
> (jemalloc), a trimmed JDK17, and a Node.js runtime — all darwin-arm64.

## Overview

The final artifact is a single `node` process: litefuse Web/API + embedded
PGlite (Postgres) + in-process Apache Doris (BE C++ + in-JVM FE). No external
Postgres / Doris / Redis / JDK / Docker.

In-process Doris wiring:

```
node process
 └─ doris_lite_embed.node (N-API addon)
      └─ dlopen libdoris_lite.dylib   (Doris BE, jemalloc build)
           └─ doris_be_run() on a BE thread; FE starts as an in-process JVM
```

---

## A. Compile doris-lite embed (libdoris_lite.dylib + addon)

### A.1 Source changes (doris-lite repo)

**`be/src/service/doris_main.cpp`** — make the BE embeddable:
- `is_embedded_mode()` reads `getenv("DORIS_LITE_EMBEDDED") == "1"`
- `main` → `extern "C" int doris_be_run(int, char**)`, gating
  `InstallFailureSignalHandler()` / `init_signals()` / `_exit(0)` behind
  `!is_embedded_mode()` (the host owns signals + lifecycle when embedded)
- add `extern "C" void doris_be_stop() { k_doris_exit = true; }`

**`be/src/service/CMakeLists.txt`** — add a `doris_be_shared` SHARED target:
- `if (BUILD_DORIS_LITE_SHARED STREQUAL "ON")` →
  `add_library(doris_be_shared SHARED doris_main.cpp)`, `OUTPUT_NAME doris_be`,
  `ENABLE_EXPORTS 1`
- `-fuse-ld=/Library/Developer/CommandLineTools/usr/bin/ld` (ld-prime): Xcode's
  ld64-530 cannot insert ARM64 branch islands for a >128MB dylib

**`be/CMakeLists.txt`** — macOS libomp fix: add
`-I/opt/homebrew/opt/libomp/include` to C/CXX flags (OpenBLAS needs `omp.h`)

### A.2 Build the dylib

```bash
cd ~/src/doris-lite/be
# JAVA_HOME must be exported too: cmake calls tools/find_libjvm.sh (a shell
# script that reads $JAVA_HOME) to locate libjvm; only then does it add the JNI
# include dirs. -DDORIS_JAVA_HOME alone is NOT enough.
export JAVA_HOME=~/src/doris-lite/output/doris_lite/jdk
cmake . -DUSE_JEMALLOC=ON \
        -DBUILD_DORIS_LITE_SHARED=ON \
        -DDORIS_JAVA_HOME="$JAVA_HOME"
ninja doris_be_shared
# output: be/build_Release/src/service/libdoris_be.dylib
```

**`USE_JEMALLOC=ON` is mandatory.** gperftools tcmalloc is not a macOS malloc
zone — when the process holds a large libsystem heap (PGlite WASM + node
modules), the cross-heap `free`s during JVM init make tcmalloc abort. jemalloc
tolerates them; this is the key fix for co-residing Doris with V8 in one process.

`DORIS_JAVA_HOME` points at the bundled JDK in
`~/src/doris-lite/output/doris_lite/jdk` (a JDK17 with headers — `jni.h` to
compile, `libjvm`/`libjsig` to link/run), so the build needs no system/homebrew
JDK. The same JDK is shipped as the release's `doris/jdk`.

### A.3 N-API addon

The addon source lives in **litefuse** at `web/src/server/doris/native/`
(`addon.c` + `binding.gyp`). It links nothing from Doris (only libdl + pthread;
resolves `doris_be_run`/`doris_be_stop` via `dlsym`), so it builds independently
of the dylib:

```bash
cd web/src/server/doris/native
npx node-gyp rebuild     # -> build/Release/doris_lite_embed.node
```

### A.4 Stage native as part of `build.sh`

The standalone builder now creates a versioned release directory under the
output directory, downloads and unpacks the matching DorisLite runtime as
`doris/`, then rebuilds the addon.

It will produce:
- `doris/lib/native/libdoris_lite.dylib`
- `native/doris_lite_embed.node`

---

## B. Build + assemble the litefuse standalone release

The source-side pieces:
- `web/src/server/doris/embeddedDoris.ts` — in-process launcher: sets env,
  eval-requires the addon, polls `SELECT 1`, wires SIGINT/SIGTERM →
  `addon.stop()`.
- `web/src/instrumentation.ts` — PGlite first, then picks in-process vs managed
  Doris via `LITEFUSE_EMBEDDED_DORIS_INPROCESS`.

### B.1 Assemble (`build.sh`)

```bash
scripts/standalone/build.sh ~/litefuse-releases
```

Creates `~/litefuse-releases/litefuse-standalone-{version}-{os}-{arch}` using
the root `package.json` version, downloads
`apache-doris-lite-{doris-version}-{os}-{arch}.tar.xz`, unpacks it as `doris/`,
builds `doris_lite_embed.node`, validates or normalizes the Doris native runtime,
runs `pnpm --filter=web build` (Next.js `output:"standalone"`), then refreshes
`app/web/.next` + `static` + `server.js`, re-syncs `bin/{start.cjs,start.sh,
stop.sh}` into the release dir, and packs a sibling tarball.

`build.sh` takes exactly one argument: an output directory. It still detects the
current host OS/arch and only rebuilds the addon for that platform. Because the
addon binary is platform-specific, you must run `build.sh` on the same platform
you are packaging for. DorisLite defaults to `4.0.5`; override with
`DORIS_LITE_VERSION=<version>` if needed.

### B.2 Binary assets produced or downloaded

| Path | Source |
|------|--------|
| `bin/node` | Node.js runtime downloaded by `build.sh` for the current host |
| `doris/jdk/` | from the downloaded DorisLite runtime |
| `doris/lib/native/libdoris_lite.dylib` | from the downloaded DorisLite runtime |
| `native/doris_lite_embed.node` | from `build.sh` (A.4/B.1) |
| `doris/{conf,lib}` | from the downloaded DorisLite runtime |
| `pglite/` | pre-migrated + seeded PGlite data (startup sets `LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED=true`) |

### B.3 Pack (built into `build.sh`)

```bash
scripts/standalone/build.sh ~/litefuse-releases
tar xf ~/litefuse-releases/litefuse-standalone-26.0.0-macos-arm64.tar.xz -C /somewhere
```

`build.sh` now cleans `bin/litefuse.pid`, `log/`, `doris/log/`, and the
FE-generated `doris/conf/log4j2-spring.xml` (carries an absolute path) before
packing `tar -cf - <dir> | xz -T0 -z` (~380MB).

---

## C. Release layout & startup

```
litefuse-standalone-0.1.0/
├── bin/      node + start.cjs (.env memory config + libjsig + spawn server) + start.sh/stop.sh
├── app/      Next standalone (server.js + trimmed node_modules)
├── native/   doris_lite_embed.node
├── doris/    lib/native/(libdoris + linux extras) + jdk/ + conf/ + doris-meta/ + storage/
├── pglite/   pre-migrated + seeded data
└── .env      STANDALONE + MEMORY config blocks
```

`./bin/start.sh` (background). `bin/start.cjs` sets
`DYLD_INSERT_LIBRARIES=<jdk>/lib/libjsig.dylib`, `JAVA_HOME=doris/jdk`, derives
node/JVM/BE limits from `LITEFUSE_MEM_LIMIT`, and spawns `app/web/server.js`
with the bundled node.

---

## D. macOS gotchas (the why)

1. **jemalloc, not tcmalloc** — tcmalloc's cross-heap `free` aborts on macOS →
   same-process Doris+V8 would crash.
2. **libjsig signal chaining** — preload `$JDK/lib/libjsig.dylib` via
   `DYLD_INSERT_LIBRARIES` so V8 and HotSpot SIGSEGV handlers chain instead of
   clobbering each other.
3. **node→node launch chain** — macOS SIP strips `DYLD_*` through `/bin/sh`,
   `/bin/bash`, `npx`, `pnpm`, `dotenv-cli`. Only node (with the
   `allow-dyld-environment-variables` entitlement) → node spawn propagates it.
   So `start.cjs` reads `.env` via the dotenv *library* (no subprocess) and
   spawns the server directly with `process.execPath`.
4. **ld-prime linker** — required for branch islands in the >128MB dylib.
5. **bundled JDK linkage** — the staged `libdoris_lite.dylib` must already
   resolve `libjvm` from the bundled `doris/jdk`; `build.sh` validates and packs
   the runtime but does not rewrite that linkage anymore.
6. **`priority_networks = 127.0.0.1/24`** (be.conf) — pins FE/BE to loopback so
   the BDBJE meta master IP still matches after the dir is moved/renamed/relocated;
   restart elects a leader cleanly.
7. **inverted index (historical)** — an earlier build's BE segfaulted on `=`
   predicates served by an inverted index, so litefuse used to
   `SET GLOBAL enable_inverted_index_query=false`. After the jemalloc rebuild it
   no longer reproduces — a full SDK regression with inverted index enabled
   passes with 0 BE crashes — so the workaround was removed.
8. **bun is unusable** — `panic: A C++ exception occurred` during JVM init (the
   Zig runtime can't carry C++ exceptions across the boundary). Use node.

---

## E. Memory note

The whole stack runs in one process, so total RSS ≈ node V8 + PGlite WASM +
FE JVM heap + BE C++. `LITEFUSE_MEM_LIMIT` auto-splits to node (50%) / JVM (25%)
/ BE (= total). On macOS the BE `mem_limit` is **not** a hard cap (it reads
`/proc/self/status`, absent on macOS), so BE memory grows on demand. A full SDK
regression needs **≥2g** (2g verified green, real RSS ≈2.13GB); 1g OOM-crashes
mid-run. See `README.md` "Memory config".

---

## F. Linux (x86_64)

The same `build.sh` / `start.sh` / `stop.sh` work unchanged;
`start.cjs` and `build.sh` branch on the platform, and `start.cjs`
swaps the macOS `DYLD_INSERT_LIBRARIES` for Linux `LD_PRELOAD` +
`GLIBC_TUNABLES` (static-TLS surplus) + `LD_LIBRARY_PATH` (bundled JDK
`lib/server` for libjvm). Deltas vs the macOS recipe above:

### F.1 Compile the BE `.so`

```bash
cd ~/src/doris-lite
# Make the BE a loadable SHARED lib + embeddable (doris_be_run/doris_be_stop,
# signals/exit gated behind DORIS_LITE_EMBEDDED) — same source changes as A.1.
# The .so must be -fPIC and dlopen-able; it ends up STATIC_TLS (internal
# thread_locals force local-exec TLS), which the runtime surplus handles.
DORIS_LITE=ON USE_JEMALLOC=ON BUILD_DORIS_LITE_SHARED=ON sh build.sh   # long
# output: be/build_Embed/src/service/libdorislite_embedded.so (~2GB unstripped)
```

Linking notes (ld.lld): thirdparty must be linkable into `-shared` — rocksdb /
libunwind shipped with local-exec TLS (`R_X86_64_TPOFF32 ... cannot be used with
-shared`) need a GD-TLS rebuild OR link the SHARED target with `-Wl,-Bsymbolic`
+ the `STATIC_TLS` dynamic flag. arrow must keep `arrow::Status::NoMessage`
(a GD-TLS thirdparty rebuild dropped it → dlopen `undefined symbol`); if you
hit that, use the original arrow `.a`.

### F.2 N-API addon

Same source as macOS (`web/src/server/doris/native/`):
```bash
cd web/src/server/doris/native && npx node-gyp rebuild   # -> doris_lite_embed.node
```

### F.3 Stage native with `build.sh`

```bash
scripts/standalone/build.sh ~/litefuse-releases
```
Run it on a Linux x86_64 host. It rebuilds the host-platform addon, copies it to
`native/doris_lite_embed.node`, downloads
`apache-doris-lite-4.0.5-linux-x64.tar.xz`, unpacks it into the generated
`litefuse-standalone-{version}-linux-x64/doris/` directory, and validates
`lib/native/libdoris_lite.so`, `lib/native/libdoris_jemalloc_preload.so`, and
`lib/native/hadoop_native/`.

### F.4 Binary assets

| Path | Source |
|------|--------|
| `bin/node` | Node.js linux-x64 runtime |
| `doris/jdk/` | from the downloaded DorisLite runtime |
| `doris/lib/native/*` | from the downloaded DorisLite runtime |
| `native/doris_lite_embed.node` | from `build.sh` (F.3) |
| `doris/{conf,lib}` | from the downloaded DorisLite runtime — **see F.5** |
| `pglite/` | pre-migrated + seeded (F.6) |

### F.5 Doris conf — REQUIRED edits

- **`arrow_flight_sql_port = -1` in BOTH fe.conf and be.conf.** The lite build
  trims the arrow-flight jars; any real port makes the FE's `QeService.start()`
  throw `NoClassDefFoundError: org/apache/arrow/flight/FlightProducer` → FE init
  fails → BE `ExecEnv::_init` leaves `_memtable_memory_limiter` null → the BE
  `memtable_memory_refresh_thread` SEGVs on a null `this`. (When the in-process
  BE crashes in a daemon thread, read `doris/log/fe.log` first — the BE crash is
  usually downstream of an FE Java exception.)
- Single effective port stanza (most Doris conf keys are last-wins): query=9030
  http=8030 rpc=9020 edit_log=9010 be=9060 webserver=8040 heartbeat=9050
  brpc=8060, `priority_networks = 127.0.0.1/32`, `enable_fe_in_process = true`,
  `fe_lib_dir = ${DORIS_HOME}/lib`. Strip any machine-specific `JAVA_HOME =
  /abs/path` from fe.conf. On a SHARED build host, shift any of these that
  collide (start.cjs's 9030/8030 stay as the FE query/http endpoints).
- **`mem_limit = 80%` (NOT `${DORIS_LITE_BE_MEM_LIMIT}`).** Unlike macOS, the
  Linux BE enforces `mem_limit` against the **whole-process RSS** (node + V8 +
  PGlite WASM + FE JVM + BE ≈ 5–6GB at idle), so the small LITEFUSE_MEM_LIMIT
  value (e.g. 4g) trips `[MEM_LIMIT_EXCEEDED] ... Allocator sys memory check
  failed` on the very first stream-load (ingestion 500s). Use an adaptive
  percentage of system RAM. Also keep only ONE `mem_limit` line — Doris does not
  treat duplicate `mem_limit` as last-wins (the env-interpolated line won),
  so `grep -v '^mem_limit' | (append 'mem_limit = 80%')`. node/JVM stay capped by
  LITEFUSE_MEM_LIMIT (start.cjs --max-old-space-size / -Xmx). Needs ≥8GB host RAM.

### F.6 Pre-migrate data (PGlite only) + Doris runtime migrations

- **PGlite** (must run from the REPO, not the standalone bundle — the bundle has
  no `packages/shared/prisma/schema.prisma`):
  ```bash
  cd ~/src/litefuse && LITEFUSE_EMBEDDED_PGLITE=true LITEFUSE_EMBEDDED_DORIS=false \
    LITEFUSE_AUTO_POSTGRES_MIGRATION_DISABLED=false \
    PGLITE_DATA_DIR=/path/to/release/pglite \
    LITEFUSE_INIT_ORG_ID=demo-org LITEFUSE_INIT_PROJECT_ID=... \
    LITEFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-... LITEFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-... \
    pnpm --filter=web run start    # boot once → migrates+seeds release/pglite, then stop
  ```
- **Doris schema**: the assembled release now applies packaged Doris migrations
  automatically on boot, after embedded Doris is query-ready. To manage Doris
  schema manually from the release directory, use:
  ```bash
  pnpm run doris:up
  pnpm run doris:down
  pnpm run doris:drop
  ```
  Wait ~20-30s after boot for the BE to register with the FE before querying
  (`No backend available as scan node ... not alive` until it does).

### F.7 Validate packed output

`scripts/standalone/build.sh ~/litefuse-releases` on a Linux x86_64 host now
also produces
`~/litefuse-releases/litefuse-standalone-26.0.0-linux-x64.tar.xz` (~368MB after
the strip, on par with the macOS build). Validate by extracting to a NEW path and
`bin/start.sh` — the meta
is relocatable (loopback `priority_networks` + `${DORIS_HOME}`-relative storage).
Process-cleanup gotcha: `kill -9` of the start.cjs launcher orphans the child
server (keeps the web port + in-process Doris); kill the server / `fuser -k
<port>/tcp` too, else the next boot hits EADDRINUSE.

### F.8 Linux gotchas (the why)

1. **LD_PRELOAD jemalloc + libjsig** (not DYLD) — jemalloc unifies the process
   allocator; libjsig chains HotSpot/V8 SIGSEGV handlers. start.cjs sets both.
2. **GLIBC_TUNABLES=glibc.rtld.optional_static_tls=65536** — the .so is
   STATIC_TLS (~33KB); the default ~2KB surplus → "cannot allocate memory in
   static TLS block". 1MB+ overshoots and breaks JVM thread creation.
3. **LD_LIBRARY_PATH at child-process start** — the BE .so's `DT_NEEDED
   libjvm.so` resolves only if `<jdk>/lib/server` is on LD_LIBRARY_PATH when the
   child node starts (runtime `process.env` mutation is too late for dlopen).
4. **processReaperUseDefaultStackSize + bigger thread stacks** — set in
   embeddedDoris.ts JAVA_OPTS on Linux so the df-exec process-reaper thread
   doesn't fault carving static TLS.
5. **production server.js, not `next dev`** — the release runs `node server.js`,
   so the turbopack-dev worker-thread hang (Rust next-swc threads vs the launch
   env) never applies; only relevant if you `next dev` in the repo (use webpack:
   `next dev` without `--turbopack`).
