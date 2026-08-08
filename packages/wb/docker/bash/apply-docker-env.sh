#!/bin/bash

set -eu

if [[ "$#" -eq 0 ]]; then
  echo "Usage: apply-docker-env.sh <command> [args...]" >&2
  exit 64
fi

# Applies the baked non-secret env file (`wb gen-docker-env` output) before running the given
# command, assigning only keys the environment does not already provide (unset or empty), so
# build args and platform-injected runtime values always win over the baked defaults.
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
  set -a
  while IFS= read -r line; do
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!key:-}" ]] || eval "$line"
  done < "$env_path"
  set +a
fi

exec "$@"
