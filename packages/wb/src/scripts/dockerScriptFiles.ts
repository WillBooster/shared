export const dockerScriptFiles = {
  'cleanup-apt.sh': `#!/bin/bash

apt-get purge -qq -y curl wget || true \\
  && apt-get autoremove -qq -y \\
  && apt-get clean -qq \\
  && rm -rf /var/lib/apt/lists/*
`,
  'configure-yarn.sh': `#!/bin/bash

yarn config set enableTelemetry 0
yarn config set enableGlobalCache 0
yarn config set nmMode hardlinks-local
yarn config set logFilters --json '[{"code":"YN0007","level":"discard"},{"code":"YN0013","level":"discard"},{"code":"YN0019","level":"discard"}]'
yarn plugin remove plugin-auto-install &> /dev/null || true
`,
  'install-asdf.sh': `#!/bin/bash

# This script MUST NOT require superuser privileges; however, prepare-asdf.sh does require them.
ASDF_VERSION=$(curl --silent "https://api.github.com/repos/asdf-vm/asdf/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\\1/') \\
  && git clone https://github.com/asdf-vm/asdf.git ~/.asdf --branch \${ASDF_VERSION} \\
  && echo 'legacy_version_file = yes' > $HOME/.asdfrc
`,
  'install-litestream.sh': `#!/bin/bash

set -e

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

# Force to use 0.5.10 since the latest litestream is very unstable.
apt-get -qq install -y --no-install-recommends curl \\
  && LITESTREAM_VERSION=$(curl --silent "https://api.github.com/repos/benbjohnson/litestream/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\\1/' | sed 's/^v//') \\
  && LITESTREAM_VERSION=0.5.10 \\
  && DEB_FILE="litestream-\${LITESTREAM_VERSION}-linux-\${ARCH}.deb" \\
  && echo "Installing Litestream: \${DEB_FILE}" \\
  && curl -sLO https://github.com/benbjohnson/litestream/releases/download/v\${LITESTREAM_VERSION}/\${DEB_FILE} \\
  && dpkg-reconfigure debconf -f noninteractive -p critical \\
  && dpkg -i \${DEB_FILE} \\
  && cp "\${SCRIPT_DIR}/run-litestream.sh" /usr/local/bin/run-litestream.sh \\
  && chmod +x /usr/local/bin/run-litestream.sh \\
  && litestream version \\
  && rm -f \${DEB_FILE}
`,
  'prepare-asdf-java.sh': `#!/bin/bash

apt-get -qq install -y --no-install-recommends tar gpg
`,
  'prepare-asdf-maven.sh': `#!/bin/bash

# do nothing
`,
  'prepare-asdf-nodejs.sh': `#!/bin/bash

# do nothing
`,
  'prepare-asdf-poetry.sh': `#!/bin/bash

# do nothing
`,
  'prepare-asdf-python.sh': `#!/bin/bash

# c.f. https://github.com/pyenv/pyenv/wiki#suggested-build-environment
apt-get -qq install -y --no-install-recommends \\
  build-essential libssl-dev zlib1g-dev \\
  libbz2-dev libreadline-dev libsqlite3-dev curl \\
  libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev
`,
  'prepare-asdf-ruby.sh': `#!/bin/bash

# cf. https://github.com/rbenv/ruby-build/wiki#ubuntudebianmint
apt-get -qq install -y --no-install-recommends autoconf patch build-essential rustc libssl-dev libyaml-dev libreadline6-dev zlib1g-dev libgmp-dev libncurses5-dev libffi-dev libgdbm6 libgdbm-dev libdb-dev uuid-dev
`,
  'prepare-asdf-yarn.sh': `#!/bin/bash

apt-get -qq install -y --no-install-recommends gpg gpg-agent
`,
  'prepare-asdf.sh': `#!/bin/bash

apt-get -qq install -y --no-install-recommends curl git
`,
  'prepare-blitz.sh': `#!/bin/bash

# Blitz.js requires libssl-dev. wb requires procps.
# TODO: merge this with bash/prepare-node-web.sh
apt-get -qq install -y --no-install-recommends ca-certificates libssl3 procps tzdata
`,
  'prepare-node-web.sh': `#!/bin/bash

# Web server requires libssl-dev. wb requires git and procps.
apt-get -qq install -y --no-install-recommends ca-certificates git libssl-dev procps tzdata
`,
  'prepare-npm-bcrypt.sh': `#!/bin/bash

# cf. https://blog.openreplay.com/node-gyp-troubleshooting-guide-fix-common-installation-build-errors/
apt-get -qq install -y --no-install-recommends g++ make python3 python3-pip && npm install -g bcrypt
`,
  'run-litestream.sh': `#!/bin/bash

set -u

if [[ "$#" -eq 0 ]]; then
  echo "Usage: run-litestream.sh <command>" >&2
  exit 64
fi

litestream replicate -exec "$*" &
litestream_pid=$!

shutdown() {
  kill -TERM "$litestream_pid" 2>/dev/null || true
  wait "$litestream_pid" 2>/dev/null || true
  exit 0
}

trap shutdown TERM INT

wait "$litestream_pid"
status=$?

# Railway sends SIGTERM during normal replacement deploys. Litestream forwards
# the signal to the app process, then reports the app's 143 as a failure.
if [[ "$status" -eq 143 || "$status" -eq 130 ]]; then
  exit 0
fi

exit "$status"
`,
} as const;
