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

apt-get -qq install -y --no-install-recommends ca-certificates curl \
  && LITESTREAM_VERSION=${LITESTREAM_VERSION:-$(curl --silent "https://api.github.com/repos/benbjohnson/litestream/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' | sed 's/^v//')} \
  && DEB_FILE="litestream-${LITESTREAM_VERSION}-linux-${ARCH}.deb" \
  && echo "Installing Litestream: ${DEB_FILE}" \
  && curl -fsSLO https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${DEB_FILE} \
  && dpkg-reconfigure debconf -f noninteractive -p critical \
  && dpkg -i "${DEB_FILE}" \
  && cp "${SCRIPT_DIR}/run-litestream.sh" /usr/local/bin/run-litestream.sh \
  && chmod +x /usr/local/bin/run-litestream.sh \
  && litestream version \
  && rm -f "${DEB_FILE}"
