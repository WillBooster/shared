#!/bin/bash

set -e

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

# Force to use 0.5.10 since the latest litestream is very unstable.
apt-get -qq install -y --no-install-recommends curl \
  && LITESTREAM_VERSION=$(curl --silent "https://api.github.com/repos/benbjohnson/litestream/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' | sed 's/^v//') \
  && LITESTREAM_VERSION=0.5.10 \
  && DEB_FILE="litestream-${LITESTREAM_VERSION}-linux-${ARCH}.deb" \
  && echo "Installing Litestream: ${DEB_FILE}" \
  && curl -sLO https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${DEB_FILE} \
  && dpkg-reconfigure debconf -f noninteractive -p critical \
  && dpkg -i ${DEB_FILE} \
  && cp "${SCRIPT_DIR}/run-litestream.sh" /usr/local/bin/run-litestream.sh \
  && chmod +x /usr/local/bin/run-litestream.sh \
  && litestream version \
  && rm -f ${DEB_FILE}
