#!/bin/bash

set -e

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

WB_KEEP_DOCKER_SCRIPTS=1 bash "${SCRIPT_DIR}/cleanup.sh"
