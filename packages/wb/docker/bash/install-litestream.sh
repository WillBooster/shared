#!/bin/bash

set -e

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
ARCH=${ARCH:-$(dpkg --print-architecture)}
LITESTREAM_VERSION=${LITESTREAM_VERSION:-0.5.12}

apt-get -qq install -y --no-install-recommends ca-certificates curl \
  && DEB_FILE="litestream-${LITESTREAM_VERSION}-linux-${ARCH}.deb" \
  && echo "Installing Litestream: ${DEB_FILE}" \
  && curl -fsSLO https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${DEB_FILE} \
  && dpkg-reconfigure debconf -f noninteractive -p critical \
  && dpkg -i "${DEB_FILE}" \
  && cp "${SCRIPT_DIR}/run-litestream.sh" /usr/local/bin/run-litestream.sh \
  && chmod +x /usr/local/bin/run-litestream.sh \
  && litestream version \
  && rm -f "${DEB_FILE}"
