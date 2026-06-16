# doris_lite_embed — in-process Doris N-API addon

A tiny Node-API addon that lets litefuse run Apache Doris (BE + in-JVM FE)
**inside the litefuse node process**. It `dlopen`s `libdoris_lite.{dylib,so}` and runs
the BE's exported `doris_be_run()` on a dedicated pthread; `doris_be_stop()` winds
it down. It links nothing from Doris at build time (only `libdl` + `pthread`) and
resolves `doris_be_run`/`doris_be_stop` via `dlsym` at runtime.

Used by `../embeddedDoris.ts`. In the standalone bundle the addon is loaded from
`<release>/native/doris_lite_embed.node`, while the Doris shared library stays at
`<release>/doris/lib/native/libdoris_lite.{dylib,so}`.

## Build

```bash
cd web/src/server/doris/native
npx node-gyp rebuild            # -> build/Release/doris_lite_embed.node
```

The compiled `.node` is platform-specific. The current checked-in build output,
for example, is a `Mach-O 64-bit bundle arm64`, so a macOS build cannot be
reused in a Linux release.

For the standalone release, `scripts/standalone/build.sh` rebuilds the addon,
then copies it to `<release>/native/doris_lite_embed.node` alongside the
packaged Doris runtime already present under `<release>/doris/`. See
`scripts/standalone/BUILD.md`.

> The addon source is portable C, but every `doris_lite_embed.node` output is a
> target-specific native binary and must match the release OS/arch.
