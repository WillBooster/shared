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

# Inherited environment variables that share this script's internal names (they are all valid
# baked keys too) would be clobbered by the parsing below, so their original values are queued
# as leading `env` assignments — placed after the baked ones, they always win. Direct
# parameter expansion (not command substitution) preserves trailing newlines in the values.
if printenv env_path > /dev/null; then set -- "env_path=${env_path:-}" "$@"; fi
if printenv line > /dev/null; then set -- "line=${line:-}" "$@"; fi
if printenv key > /dev/null; then set -- "key=${key:-}" "$@"; fi
if printenv value > /dev/null; then set -- "value=${value:-}" "$@"; fi
if printenv assignments > /dev/null; then set -- "assignments=${assignments:-}" "$@"; fi

env_path=./.docker.env

# The applied values are handed to the child via `env` instead of shell assignments, so Bash
# readonly names (UID, EUID, ...) are valid baked keys.
assignments=()
if [[ -f "$env_path" ]]; then
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
