#!/bin/bash

# Adapts the wbfy-generated bunfig.toml in the current directory to a Docker image: drops the
# project-owned [test] sections (a production image never runs `bun test`) and forces globalStore
# off (a single-use image never reuses a global store, and store symlinks outside the project root
# break multi-stage COPY of node_modules).
#
# No global config is written: bun reads this very file, whose minimumReleaseAge and
# minimumReleaseAgeExcludes carry the organization's release-age policy, and images resolve
# dependencies with bun only.

set -euo pipefail

awk '/^\[/ { inTestSection = ($0 ~ /^\[test/) } !inTestSection' bunfig.toml |
  sed 's/^globalStore = true$/globalStore = false/' > bunfig.toml.tmp
mv bunfig.toml.tmp bunfig.toml
