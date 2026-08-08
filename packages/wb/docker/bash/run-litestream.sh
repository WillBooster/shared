#!/bin/bash

set -u

if [[ "$#" -eq 0 ]]; then
  echo "Usage: run-litestream.sh <command>" >&2
  exit 64
fi

# Fail fast when the config references environment variables (e.g. the ${VAR} placeholders of
# `wb db create-litestream-config --env-refs`) that the platform did not supply: Litestream
# itself only logs and retries replica errors, which would silently disable backups.
# LITESTREAM_CONFIG is Litestream's own config-path override, so the validated file is always
# the file `litestream replicate` below actually reads.
config_path="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
if [[ -f "$config_path" ]]; then
  while IFS= read -r key; do
    if [[ -z "$(printenv "$key" || true)" ]]; then
      echo "run-litestream.sh: environment variable $key is required by $config_path but is not set." >&2
      exit 1
    fi
  done < <(grep -o '\${[A-Za-z_][A-Za-z0-9_]*}' "$config_path" | tr -d '${}' | sort -u)
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
