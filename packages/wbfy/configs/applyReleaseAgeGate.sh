#!/bin/bash
# Writes the organization's minimum-release-age policy — releaseAgeGate.json next to this script is
# its single source of truth — into every global package-manager config this machine can read:
# ~/.npmrc (npm, bun, yarn 1), ~/.yarnrc.yml (Yarn Berry) and ~/.bunfig.toml (bun), plus the same
# files under $XDG_CONFIG_HOME (bun reads its global configs ONLY from there once that variable is
# set) and under root's home (self-hosted setup runs `sudo npm install --global`).
#
# The gate keys are always rewritten, so a hand-weakened gate never survives; the registry settings
# that precede them are kept as they are, or replaced by $NPMRC_HEADER / $YARNRC_HEADER when the
# caller provisions them (self-host-utils passes the Takumi Guard proxy that way). Run this as the
# user whose configs it should update. Only up-to-date package managers are supported: npm >= 12
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

npmrcHeader=${NPMRC_HEADER-$(sed '/^min-release-age/,$d' "$HOME/.npmrc" 2> /dev/null || true)}
yarnrcHeader=${YARNRC_HEADER-$(sed '/^npmMinimalAgeGate:/,$d' "$HOME/.yarnrc.yml" 2> /dev/null || true)}

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

write() { # $1: directory, $2: command prefix granting write access to it
  $2 mkdir -p "$1"
  printf '%s\n' "$npmrc" | $2 tee "$1/.npmrc" > /dev/null
  printf '%s\n' "$yarnrc" | $2 tee "$1/.yarnrc.yml" > /dev/null
  printf '%s\n' "$bunfig" | $2 tee "$1/.bunfig.toml" > /dev/null
}

write "$HOME" ''
if [ -n "${XDG_CONFIG_HOME:-}" ]; then write "$XDG_CONFIG_HOME" ''; fi
# -n: a developer machine without passwordless sudo skips root's configs instead of prompting.
if sudo -n true 2> /dev/null; then write ~root sudo; fi

echo "Applied the ${days}-day minimum-release-age policy to the global package-manager configs."
