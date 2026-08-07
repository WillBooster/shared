#!/bin/bash

# Force-overwrites the npm / yarn / bun config files inside a Docker image with the
# organization-standard content. The release-age gate values come from the wbfy-generated
# bunfig.toml in the current directory, so the image needs no other source of the org policy.
#
# Unconditional overwrites are intentional: images never hold package-manager credentials
# (private packages are materialized on the host; see WillBooster/shared#964), and a production
# image never runs `bun test`, so existing config lines and `[test]` sections need no preserving.
# Like the wbfy global gate, this assumes up-to-date package managers (e.g. Yarn >= 4.10 for
# npmMinimalAgeGate); older versions must be upgraded, not accommodated.

set -euo pipefail

seconds=$(sed -n 's/^minimumReleaseAge = \([0-9]*\).*/\1/p' bunfig.toml)
# sed exits 0 on no match, so an unregenerated bunfig.toml (older than wbfy's gate) must be
# rejected here; otherwise the gate silently becomes 0 and the generated bunfig.toml is invalid.
case "${seconds}" in
  '' | *[!0-9]*)
    echo 'bunfig.toml has no numeric minimumReleaseAge; run wbfy to regenerate it.' >&2
    exit 1
    ;;
esac
excludes=$(sed -n '/^minimumReleaseAgeExcludes = \[/,/^]/s/^[[:space:]]*"\(.*\)",$/\1/p' bunfig.toml)
days=$((seconds / 86400))
minutes=$((seconds / 60))

{
  echo "min-release-age=${days}"
  for package in ${excludes}; do
    echo "min-release-age-exclude[]=${package}"
  done
} > ~/.npmrc

{
  echo "npmMinimalAgeGate: ${minutes} # ${days} days"
  echo 'npmPreapprovedPackages:'
  for package in ${excludes}; do
    echo "  - '${package}'"
  done
} > ~/.yarnrc.yml

# Keep the wbfy-generated bunfig.toml as the single source of the Bun settings; drop only the
# project-owned [test] sections and force globalStore off (a single-use image never reuses a
# global store, and store symlinks outside the project root break multi-stage COPY of
# node_modules).
awk '/^\[/ { inTestSection = ($0 ~ /^\[test/) } !inTestSection' bunfig.toml |
  sed 's/^globalStore = true$/globalStore = false/' > bunfig.toml.tmp
mv bunfig.toml.tmp bunfig.toml
