# litefuse standalone — build / run / pack scripts

Scripts for the single-process, self-contained litefuse release. One `node`
process runs **litefuse Web/API + embedded PGlite (Postgres) + in-process Apache
Doris (BE + in-JVM FE)** together. Supports **macOS arm64** and **Linux x86_64**
(each ships a prebuilt Doris BE lib, a trimmed JDK17, and the Node.js runtime).
`start.cjs` and `build.sh` auto-detect the platform; see
[BUILD.md](BUILD.md) §F for the Linux-specific build steps and gotchas.

## Files

Runtime scripts (copied into the release's `bin/` by `build.sh`):

| File | Purpose |
|------|---------|
| `start.cjs` | Launcher: parses `.env` memory config → derives per-component limits → injects the libjsig signal chain + in-bundle paths → spawns the Next standalone server |
| `start.sh` | Background start (writes `bin/litefuse.pid`, log `log/litefuse.out`); `-f`/`--foreground` runs in the foreground |
| `stop.sh` | Stop (reads `bin/litefuse.pid`, cascades to the server + in-process Doris) |
| `doris-migrations.cjs` | Standalone-local Doris migration CLI used by startup auto-migration and by `pnpm run doris:up/down/drop` in the release root |

Build-time scripts:

| File | Purpose |
|------|---------|
| `build.sh <output-dir>` | One-shot build for the current host: creates `<output-dir>/litefuse-standalone-{version}-{os}-{arch}`, downloads and unpacks the matching DorisLite runtime as `doris/`, rebuilds the platform-specific Doris addon, compiles the JS app, downloads the matching Node.js runtime, syncs launch scripts, migrations, release `package.json`, then packs `<name>.tar.xz` next to it |

> Full from-scratch build (including compiling the doris-lite embed dylib/addon):
> see [BUILD.md](BUILD.md).

Dev script (NOT bundled into the release):

| File | Purpose |
|------|---------|
| `start-inprocess.cjs` | Boots the repo's `next dev`/`next start` with in-process Doris + libjsig from the dev tree (uses system `JAVA_HOME`, `web/`, `.env`). For local development, not the packaged release. `node scripts/standalone/start-inprocess.cjs` |

> `build.sh` takes exactly one argument: an output directory. It still only
> builds for the current host OS/arch, and it creates a versioned release
> directory named `litefuse-standalone-{version}-{os}-{arch}` inside that output
> directory. DorisLite defaults to version `4.0.5`; override with
> `DORIS_LITE_VERSION=<version>` if needed.

## Doris migrations in the release

On standalone boot, after embedded Doris becomes query-ready, litefuse now runs
the packaged `bin/doris-migrations.cjs up` automatically unless
`LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED=true`.

The standalone Doris migration CLI reads SQL files from
`./app/packages/shared/doris/migrations`, matching the packaged PGlite/Prisma
migration layout under `./app/packages/shared`.

The release root also gets a minimal `package.json`, so users can manage Doris
schema manually from the unpacked release directory (backed by the bundled
`./bin/node` runtime):

```bash
pnpm run doris:up
pnpm run doris:down
pnpm run doris:drop
```

## Typical flow

```bash
# After changing web sources (incl. web/src/server/doris/*.ts), rebuild + pack:
scripts/standalone/build.sh ~/litefuse-releases
# Unpack & run:
tar xf ~/litefuse-releases/litefuse-standalone-26.0.0-macos-arm64.tar.xz -C /somewhere
/somewhere/litefuse-standalone-26.0.0-macos-arm64/bin/start.sh
```

## Memory config (release `.env`, parsed by `start.cjs`)

| Key | Controls | Default | Precision |
|-----|----------|---------|-----------|
| `LITEFUSE_MEM_LIMIT` | Total budget; also used as BE's `mem_limit` | `2g` | Whole-process RSS (see below) |
| `LITEFUSE_NODE_MEM_LIMIT` | node `--max-old-space-size` | `1g` (50% of total) | V8 old-space JS heap only |
| `LITEFUSE_JVM_MEM_LIMIT` | Doris FE in-JVM `-Xmx` (`-Xms` = 50% of it) | `512m` (25% of total) | JVM heap hard cap |

If only `LITEFUSE_MEM_LIMIT` is set, it auto-splits: NODE=50%, JVM=25%, BE=total.
Units `g`/`m`; a bare number is MB.

**Precision differences (important):**
- **JVM (`-Xmx`)** is the only "per-component + hard" limit (metaspace / thread
  stacks / DirectBuffer still live off-heap, so actual RSS is a bit above `-Xmx`).
- **node**'s `--max-old-space-size` only caps the V8 old-space **JS heap** — it
  excludes Buffers, PGlite's WASM linear memory, and native addons (Doris BE/FE).
- **BE**'s `mem_limit` accounts for the **whole-process RSS**
  (`process_memory_usage() = get_vm_rss() + …`), so it is merged into
  `LITEFUSE_MEM_LIMIT`. ⚠️ On macOS there is no `/proc`, so BE's hard `mem_limit`
  never triggers — it only acts as a cache/GC soft hint.

## Where the memory code lives

| Location | Responsibility |
|----------|----------------|
| `scripts/standalone/start.cjs` (→ release `bin/start.cjs`) | Parse `.env`, derive node/JVM/BE limits, set `--max-old-space-size` + internal env |
| `web/src/server/doris/embeddedDoris.ts` · `managedDoris.ts` | Read `DORIS_LITE_FE_MAX_HEAP/MIN_HEAP` → JVM `-Xmx/-Xms` |
| release `doris/conf/be.conf` | `mem_limit = ${DORIS_LITE_BE_MEM_LIMIT}` |
| release `.env` | `LITEFUSE_*` config values (single source) |

## Note on the embedding flag

The BE dylib reads an env flag to enter in-process mode. The canonical name is
`DORIS_LITE_EMBEDDED`; `start.cjs`/`embeddedDoris.ts` also set the legacy
`DORISLITE_EMBEDDED` so the currently shipped dylib (which still `getenv`s the old
name) keeps working. The doris-lite C++/CMake sources already use the new name —
the alias can be dropped once the dylib is rebuilt.
