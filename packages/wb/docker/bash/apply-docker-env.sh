#!/bin/bash

set -eu

if [[ "$#" -eq 0 ]]; then
  echo "Usage: apply-docker-env.sh <command> [args...]" >&2
  exit 64
fi

# Applies the baked non-secret env file (`wb gen-docker-env` output) before running the given
# command, passing only keys absent from the inherited environment, so build args and
# platform-injected runtime values — including deliberately empty ones — always win over the
# baked defaults (colon-less `${KEY=...}` semantics).
# An explicitly configured path must exist: silently starting without the baked configuration
# would be the very silent-degradation mode this helper exists to prevent.
if [[ -n "${DOCKER_ENV_PATH:-}" && ! -f "$DOCKER_ENV_PATH" ]]; then
  echo "apply-docker-env.sh: DOCKER_ENV_PATH=$DOCKER_ENV_PATH does not exist." >&2
  exit 1
fi
env_path="${DOCKER_ENV_PATH:-}"
if [[ -z "$env_path" ]]; then
  for candidate in ./.docker.env ./.env; do
    if [[ -f "$candidate" ]]; then
      env_path="$candidate"
      break
    fi
  done
fi

# The applied values are handed to the child via `env` instead of being assigned in this shell:
# assigning would abort on Bash readonly names (UID, EUID, ...), which are valid baked keys.
# Bookkeeping variables use collision-improbable names so inherited variables such as
# `line`/`key` — also valid baked keys — are never overwritten.
wb_baked_assignments=()
if [[ -n "$env_path" ]]; then
  # `|| [[ -n "$wb_baked_line" ]]` keeps a final line that lacks a trailing newline.
  while IFS= read -r wb_baked_line || [[ -n "$wb_baked_line" ]]; do
    wb_baked_key="${wb_baked_line%%=*}"
    [[ "$wb_baked_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # printenv inspects the inherited environment, not Bash's variable namespace, so
    # shell-internal names do not shadow baked keys and a platform value deliberately set to
    # the empty string survives.
    printenv "$wb_baked_key" > /dev/null && continue
    # Evaluate only the (single-quoted) value into a bookkeeping variable.
    eval "wb_baked_value=${wb_baked_line#*=}"
    wb_baked_assignments+=("$wb_baked_key=$wb_baked_value")
  done < "$env_path"
fi

if [[ "${#wb_baked_assignments[@]}" -gt 0 ]]; then
  exec env "${wb_baked_assignments[@]}" "$@"
fi
exec "$@"
