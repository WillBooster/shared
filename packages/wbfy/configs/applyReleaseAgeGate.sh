#!/bin/bash
# Writes the organization's minimum-release-age policy — releaseAgeGate.json next to this script is
# its single source of truth — into the global package-manager configs of the user running it:
# ~/.npmrc (npm, bun, yarn 1), ~/.yarnrc.yml (Yarn Berry) and ~/.bunfig.toml (bun), plus the same
# files under $XDG_CONFIG_HOME (bun reads its global configs ONLY from there once that variable is
# set). Run it once per user whose configs must be gated: `sudo -H env -u XDG_CONFIG_HOME bash
# applyReleaseAgeGate.sh` covers root, whose configs `sudo npm install --global` reads.
#
# Every managed setting is rewritten on each run, so a hand-weakened gate never survives:
# - .npmrc and .yarnrc.yml keep every setting except the gate keys, because npm and Yarn append
#   settings a user writes later (e.g. `npm config set`, `yarn config set --home`) below them.
#   $NPMRC_HEADER / $YARNRC_HEADER replace what is kept when the caller provisions those settings
#   itself (self-host-utils passes the Takumi Guard proxy that way).
# - .bunfig.toml is replaced wholesale: bun reads its registry settings and credentials from
#   .npmrc, so the organization keeps nothing else in this file.
#
# A failed write aborts the run instead of moving on: leaving some package managers ungated must be
# reported, not silently downgraded. Only up-to-date package managers are supported: npm >= 12
# (`min-release-age-exclude`), Yarn Berry >= 4.11 (`npmMinimalAgeGate`) and bun >= 1.3
# (`minimumReleaseAge`) — older ones must be upgraded instead of accommodated.

set -euo pipefail
umask 077

gateJsonPath="$(dirname "${BASH_SOURCE[0]}")/releaseAgeGate.json"
days=$(sed -n 's/.*"days"[^0-9]*\([0-9]*\).*/\1/p' "$gateJsonPath")
excludes=$(tr -d ' \n' < "$gateJsonPath" | sed 's/.*"excludes":\[//; s/].*//; s/"//g' | tr ',' '\n')

emitHeader() {
  [ -n "$1" ] && printf '%s\n' "$1"
  return 0
}

npmrcHeader=${NPMRC_HEADER-$(sed '/^min-release-age/d' "$HOME/.npmrc" 2> /dev/null || true)}
# Drop the two managed top-level keys with their indented values, keep every other key.
yarnrcHeader=${YARNRC_HEADER-$(awk '
  /^[^ ]/ { drop = ($1 == "npmMinimalAgeGate:" || $1 == "npmPreapprovedPackages:") }
  !drop' "$HOME/.yarnrc.yml" 2> /dev/null || true)}

npmrc=$(
  emitHeader "$npmrcHeader"
  echo "min-release-age=$days"
  echo "$excludes" | sed 's|^|min-release-age-exclude[]=|'
)
# Minutes as a plain number: Yarn parses a unit-less value in the setting's own unit, while duration
# strings were misparsed by pre-DURATION versions of the setting (yarnpkg/berry#6942).
yarnrc=$(
  emitHeader "$yarnrcHeader"
  echo "npmMinimalAgeGate: $((days * 24 * 60))"
  echo 'npmPreapprovedPackages:'
  echo "$excludes" | sed "s|^|  - '|; s|$|'|"
)
bunfig=$(
  echo '[install]'
  echo "minimumReleaseAge = $((days * 24 * 60 * 60))"
  echo 'minimumReleaseAgeExcludes = ['
  echo "$excludes" | sed 's|^|  "|; s|$|",|'
  echo ']'
)

write() { # $1: directory
  mkdir -p "$1"
  printf '%s\n' "$npmrc" > "$1/.npmrc"
  printf '%s\n' "$yarnrc" > "$1/.yarnrc.yml"
  printf '%s\n' "$bunfig" > "$1/.bunfig.toml"
}

write "$HOME"
if [ -n "${XDG_CONFIG_HOME:-}" ]; then write "$XDG_CONFIG_HOME"; fi

echo "Applied the ${days}-day minimum-release-age policy to ${HOME}'s global package-manager configs."
