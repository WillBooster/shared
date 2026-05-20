#!/bin/bash

# c.f. https://github.com/pyenv/pyenv/wiki#suggested-build-environment
apt-get -qq install -y --no-install-recommends \
  build-essential libssl-dev zlib1g-dev \
  libbz2-dev libreadline-dev libsqlite3-dev curl \
  libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev
