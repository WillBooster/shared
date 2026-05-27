#!/bin/bash

# Blitz.js requires libssl-dev. wb requires lsof and procps.
# TODO: merge this with bash/prepare-node-web.sh
apt-get -qq install -y --no-install-recommends ca-certificates libssl3 lsof procps tzdata
