#!/bin/bash

# This script MUST NOT require superuser privileges; however, prepare-asdf.sh does require them.
ASDF_VERSION=$(curl --silent "https://api.github.com/repos/asdf-vm/asdf/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/') \
  && git clone https://github.com/asdf-vm/asdf.git ~/.asdf --branch ${ASDF_VERSION} \
  && echo 'legacy_version_file = yes' > $HOME/.asdfrc
