#!/bin/bash

# Web server requires libssl-dev. wb requires git, lsof, and procps.
apt-get -qq install -y --no-install-recommends ca-certificates git libssl-dev lsof procps tzdata
