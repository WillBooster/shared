#!/bin/bash

# Web server requires libssl-dev. wb requires git and procps.
apt-get -qq install -y --no-install-recommends ca-certificates git libssl-dev procps tzdata
