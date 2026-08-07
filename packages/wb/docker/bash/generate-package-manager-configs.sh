#!/bin/bash

# Force-overwrites the npm / yarn / bun config files inside a Docker image with the
# organization-standard content. The release-age gate values come from the wbfy-generated
# bunfig.toml in the current directory, so the image needs no other source of the org policy.

set -eu

seconds=$(sed -n 's/^minimumReleaseAge = \([0-9]*\).*/\1/p' bunfig.toml)
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

{
  echo 'env = false'
  echo 'telemetry = false'
  echo ''
  echo '[install]'
  echo 'exact = true'
  # A single-use image never reuses a global store, and store symlinks outside the project root
  # break multi-stage COPY of node_modules.
  echo 'globalStore = false'
  echo 'linker = "isolated"'
  echo 'publicHoistPattern = ["tsx", "undici-types"]'
  echo "minimumReleaseAge = ${seconds} # ${days} days"
  echo 'minimumReleaseAgeExcludes = ['
  for package in ${excludes}; do
    echo "    \"${package}\","
  done
  echo ']'
} > bunfig.toml
