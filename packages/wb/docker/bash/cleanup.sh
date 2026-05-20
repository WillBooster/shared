#!/bin/bash

set -e

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

apt-get purge -qq -y curl wget || true
apt-get autoremove -qq -y
apt-get clean -qq
rm -rf /var/lib/apt/lists/*

if [ -z "${WB_KEEP_DOCKER_SCRIPTS:-}" ] && [ "$(basename "${SCRIPT_DIR}")" = "bash" ]; then
  rm -rf "${SCRIPT_DIR}"
fi
