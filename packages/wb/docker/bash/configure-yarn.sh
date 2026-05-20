#!/bin/bash

yarn config set enableTelemetry 0
yarn config set enableGlobalCache 0
yarn config set nmMode hardlinks-local
yarn config set logFilters --json '[{"code":"YN0007","level":"discard"},{"code":"YN0013","level":"discard"},{"code":"YN0019","level":"discard"}]'
yarn plugin remove plugin-auto-install &> /dev/null || true
