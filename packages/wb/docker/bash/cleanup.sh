#!/bin/bash

set -e

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
keep_scripts=0

for arg in "$@"; do
  case "${arg}" in
    --keep-scripts)
      keep_scripts=1
      ;;
    *)
      echo "Usage: cleanup.sh [--keep-scripts]" >&2
      exit 1
      ;;
  esac
done

apt-get purge -qq -y curl wget || true
apt-get autoremove -qq -y
apt-get clean -qq
rm -rf /var/lib/apt/lists/*

if [ "${keep_scripts}" = 0 ] && [ "$(basename "${SCRIPT_DIR}")" = "bash" ]; then
  rm -rf "${SCRIPT_DIR}"
fi
