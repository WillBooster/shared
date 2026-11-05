#!/bin/bash

set -e

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ -z "${ARCH:-}" ]]; then
  case "$(uname -m)" in
    arm64 | aarch64) ARCH=arm64 ;;
    x86_64) ARCH=x86_64 ;;
    *) ARCH=$(uname -m) ;;
  esac
fi

# renovate: datasource=github-releases depName=benbjohnson/litestream
LITESTREAM_VERSION=${LITESTREAM_VERSION:-0.5.18}
DEB_FILE="litestream-${LITESTREAM_VERSION}-linux-${ARCH}.deb"

apt-get -qq install -y --no-install-recommends ca-certificates curl
echo "Installing Litestream: ${DEB_FILE}"
curl -fsSLO "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${DEB_FILE}"
dpkg-reconfigure debconf -f noninteractive -p critical
dpkg -i "${DEB_FILE}"
cp "${SCRIPT_DIR}/run-litestream.sh" /usr/local/bin/run-litestream.sh
chmod +x /usr/local/bin/run-litestream.sh
litestream version
rm -f "${DEB_FILE}"
