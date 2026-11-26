#!/bin/sh

# Retry twice after the first failure, then propagate apk's exit status.
for delay in 2 4; do
    apk "$@" && exit 0
    echo "apk $1 failed, retrying in ${delay}s" >&2
    sleep "$delay"
done
exec apk "$@"
