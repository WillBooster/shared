#!/bin/bash
# Writes the organization's minimum-release-age policy — releaseAgeGate.json next to this script is
# its single source of truth — into the global package-manager configs of the user running it:
# ~/.npmrc (npm, bun, yarn 1), ~/.yarnrc.yml (Yarn Berry), ~/.bunfig.toml (bun) and bun's copies
# under $XDG_CONFIG_HOME. Run it once per user whose configs must be gated: `sudo -H env -u
# XDG_CONFIG_HOME bash applyReleaseAgeGate.sh` covers root, whose configs `sudo npm install
# --global` reads.
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
# `sed -n …p` prints only on a match, so a truncated array (no closing bracket) yields nothing.
excludes=$(tr -d ' \n' < "$gateJsonPath" | sed -n 's/.*"excludes":\[\(.*\)].*/\1/p' | tr -d '"' | tr ',' '\n')
# Without this, a truncated or stale JSON would write a disabled gate (`min-release-age=`,
# `minimumReleaseAge = 0`) or a silently shortened exclusion list while reporting success.
[ "$days" -gt 0 ] 2> /dev/null && [ -n "$excludes" ] ||
  { echo "$gateJsonPath is not a valid release-age gate." >&2; exit 1; }

emitHeader() {
  [ -n "$1" ] && printf '%s\n' "$1"
  return 0
}

# `! [ -e … ] ||` skips an absent file but lets a read failure abort the run: overwriting a config
# whose current settings could not be read would silently drop them.
npmrcHeader=${NPMRC_HEADER-$(! [ -e "$HOME/.npmrc" ] || sed '/^min-release-age/d' "$HOME/.npmrc")}
# Drop the two managed top-level keys with their indented values, keep every other key.
yarnrcHeader=${YARNRC_HEADER-$(! [ -e "$HOME/.yarnrc.yml" ] || awk '
  /^[^ ]/ { drop = ($1 == "npmMinimalAgeGate:" || $1 == "npmPreapprovedPackages:") }
  !drop' "$HOME/.yarnrc.yml")}

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

# Staged and renamed into place: a package manager installing on this machine while the configs are
# rewritten must never read a half-written file and resolve packages ungated or from the wrong
# registry. It also replaces a pre-existing symlink instead of writing through it.
writeFile() { # $1: content, $2: destination
  printf '%s\n' "$1" > "$2.staging"
  mv -f "$2.staging" "$2"
}

writeFile "$npmrc" "$HOME/.npmrc"
writeFile "$yarnrc" "$HOME/.yarnrc.yml"
writeFile "$bunfig" "$HOME/.bunfig.toml"

# Once $XDG_CONFIG_HOME is set, bun reads BOTH its .bunfig.toml and its .npmrc from there and never
# falls back to $HOME (verified with bun 1.3.14), so its installs would otherwise run ungated and
# bypass the registry settings. npm and Yarn Berry always read $HOME, hence no .yarnrc.yml here.
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  mkdir -p "$XDG_CONFIG_HOME"
  writeFile "$npmrc" "$XDG_CONFIG_HOME/.npmrc"
  writeFile "$bunfig" "$XDG_CONFIG_HOME/.bunfig.toml"
fi

echo "Applied the ${days}-day minimum-release-age policy to ${HOME}'s global package-manager configs."
