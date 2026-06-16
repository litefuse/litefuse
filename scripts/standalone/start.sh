#!/usr/bin/env bash
# litefuse-standalone launcher — starts in the BACKGROUND like Doris start_be.sh.
# Uses the BUNDLED node runtime (bin/node); no system Node.js required.
# start.cjs then spawns the server with the same bundled node (process.execPath)
# + libjsig, so DYLD_* is never stripped.
set -eo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # bin/
ROOT="$(cd "$DIR/.." && pwd)"
LOG_DIR="$ROOT/log"
PID_FILE="$DIR/litefuse.pid"
mkdir -p "$LOG_DIR"

# Linux: give the main thread / default pthread stack 8MB so the in-process JVM's
# reaper/df threads can carve the BE .so's static-TLS block (no-op on macOS).
ulimit -s 8192 2>/dev/null || true

# Refuse to double-start.
if [ -f "$PID_FILE" ]; then
  OLD="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "litefuse already running (pid $OLD). Run bin/stop.sh first." >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

# Run in foreground if asked: bin/start.sh -f  (Ctrl-C to stop)
if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--foreground" ]; then
  shift
  exec "$DIR/node" "$DIR/start.cjs" "$@"
fi

nohup "$DIR/node" "$DIR/start.cjs" "$@" >>"$LOG_DIR/litefuse.out" 2>&1 </dev/null &
PID=$!
echo "$PID" >"$PID_FILE"
echo "litefuse started in background (pid $PID)"
echo "  log:  $LOG_DIR/litefuse.out"
echo "  stop: $DIR/stop.sh"
echo "  web:  http://localhost:${PORT:-3000}  (ready in ~30-60s)"
