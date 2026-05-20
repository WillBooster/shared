#!/bin/bash

apt-get purge -qq -y curl wget || true \
  && apt-get autoremove -qq -y \
  && apt-get clean -qq \
  && rm -rf /var/lib/apt/lists/*
