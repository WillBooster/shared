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

# Inherited environment variables that share this script's internal names (they are all valid
# baked keys too) would be clobbered by the parsing below, so their original values are queued
# as leading `env` assignments — placed after the baked ones, they always win. `$(printenv ...)`
# strips trailing newlines, which `wb gen-docker-env` values cannot contain anyway.
if printenv env_path > /dev/null; then set -- "env_path=$(printenv env_path)" "$@"; fi
if printenv candidate > /dev/null; then set -- "candidate=$(printenv candidate)" "$@"; fi
if printenv line > /dev/null; then set -- "line=$(printenv line)" "$@"; fi
if printenv key > /dev/null; then set -- "key=$(printenv key)" "$@"; fi
if printenv value > /dev/null; then set -- "value=$(printenv value)" "$@"; fi
if printenv assignments > /dev/null; then set -- "assignments=$(printenv assignments)" "$@"; fi

env_path="${DOCKER_ENV_PATH:-}"
if [[ -z "$env_path" ]]; then
  for candidate in ./.docker.env ./.env; do
    if [[ -f "$candidate" ]]; then
      env_path="$candidate"
      break
    fi
  done
fi

# The applied values are handed to the child via `env` instead of shell assignments, so Bash
# readonly names (UID, EUID, ...) are valid baked keys.
assignments=()
if [[ -n "$env_path" ]]; then
  # `|| [[ -n "$line" ]]` keeps a final line that lacks a trailing newline.
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # printenv inspects the inherited process environment, so a platform value deliberately
    # set to the empty string survives and shell-internal names do not shadow baked keys.
    printenv "$key" > /dev/null && continue
    # Evaluate only the (single-quoted) value.
    eval "value=${line#*=}"
    assignments+=("$key=$value")
  done < "$env_path"
fi

# Always route through env: with no assignments it simply runs the command, and a restored
# KEY=VALUE at the head of "$@" is then interpreted as an assignment, never as the command.
exec env ${assignments+"${assignments[@]}"} "$@"
