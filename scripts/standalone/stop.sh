#!/usr/bin/env bash
# Stop the background litefuse-standalone started by bin/start.sh.
# Kills the start.cjs launcher pid; its SIGTERM handler forwards to the Next
# server child, which stops in-process Doris (addon.stop) on the way out.
set -eo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # bin/
PID_FILE="$DIR/litefuse.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "no pid file ($PID_FILE); litefuse not running?"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "litefuse not running (stale pid file removed)"
  rm -f "$PID_FILE"
  exit 0
fi

echo "stopping litefuse (pid $PID)..."
kill "$PID" 2>/dev/null || true
for _ in $(seq 1 30); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "still alive after 30s; force killing $PID"
  kill -9 "$PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"
echo "litefuse stopped"
