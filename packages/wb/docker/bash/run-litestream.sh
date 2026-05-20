#!/bin/bash

set -u

if [[ "$#" -eq 0 ]]; then
  echo "Usage: run-litestream.sh <command>" >&2
  exit 64
fi

litestream replicate -exec "$*" &
litestream_pid=$!

shutdown() {
  kill -TERM "$litestream_pid" 2>/dev/null || true
  wait "$litestream_pid" 2>/dev/null || true
  exit 0
}

trap shutdown TERM INT

wait "$litestream_pid"
status=$?

# Railway sends SIGTERM during normal replacement deploys. Litestream forwards
# the signal to the app process, then reports the app's 143 as a failure.
if [[ "$status" -eq 143 || "$status" -eq 130 ]]; then
  exit 0
fi

exit "$status"
