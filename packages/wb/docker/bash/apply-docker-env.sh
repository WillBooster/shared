#!/bin/bash

set -eu

if [[ "$#" -eq 0 ]]; then
  echo "Usage: apply-docker-env.sh <command> [args...]" >&2
  exit 64
fi

# Applies the baked non-secret env file (`wb gen-docker-env` output) before running the given
# command, assigning only keys absent from the inherited environment, so build args and
# platform-injected runtime values — including deliberately empty ones — always win over the
# baked defaults (colon-less `${KEY=...}` semantics).
env_path="${DOCKER_ENV_PATH:-}"
if [[ -z "$env_path" ]]; then
  for candidate in ./.docker.env ./.env; do
    if [[ -f "$candidate" ]]; then
      env_path="$candidate"
      break
    fi
  done
fi

if [[ -n "$env_path" && -f "$env_path" ]]; then
  # Bookkeeping variables use collision-improbable names and stay unexported (allexport is
  # scoped to each applied assignment), so they neither leak into the executed process nor
  # overwrite inherited variables such as `line`/`key`, which remain valid baked keys.
  # `|| [[ -n "$wb_baked_line" ]]` keeps a final line that lacks a trailing newline.
  while IFS= read -r wb_baked_line || [[ -n "$wb_baked_line" ]]; do
    wb_baked_key="${wb_baked_line%%=*}"
    [[ "$wb_baked_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # printenv inspects the inherited environment, not Bash's variable namespace, so
    # shell-internal names (UID, RANDOM, ...) do not shadow baked keys and a platform value
    # deliberately set to the empty string survives.
    if ! printenv "$wb_baked_key" > /dev/null; then
      set -a
      eval "$wb_baked_line"
      set +a
    fi
  done < "$env_path"
fi

exec "$@"
