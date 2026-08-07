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

# The image's only release-age gate is this file, so an unregenerated bunfig.toml (older than wbfy's
# gate) must fail the build instead of silently producing an ungated image.
grep -q '^minimumReleaseAge = [0-9]' bunfig.toml ||
  { echo 'bunfig.toml has no minimumReleaseAge; run wbfy to regenerate it.' >&2; exit 1; }

awk '/^\[/ { inTestSection = ($0 ~ /^\[test/) } !inTestSection' bunfig.toml |
  sed 's/^globalStore = true$/globalStore = false/' > bunfig.toml.tmp
mv bunfig.toml.tmp bunfig.toml
