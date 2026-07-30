#!/bin/bash

changed_files="$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD)"

run_if_changed() {
  if echo "$changed_files" | grep --quiet -E "$1"; then
    eval "$2"
  fi
}

run_if_changed "(mise\.toml|\.mise\.toml|\.tool-versions|\..+-version)" "mise install"
if git diff --no-color -U0 ORIG_HEAD HEAD -- '*bunfig.toml' | grep --quiet -E '^[+-] *(globalStore|linker|publicHoistPattern)'; then rm -Rf -- 'node_modules' 'packages/shared-lib-blitz-next/node_modules' 'packages/shared-lib-next/node_modules' 'packages/shared-lib-node/node_modules' 'packages/shared-lib-react/node_modules' 'packages/shared-lib/node_modules' 'packages/wb/node_modules' 'packages/wbfy/node_modules'; fi
run_if_changed "(package\.json|bun\.lock|bunfig\.toml|\.npmrc|patches/)" "bun install"
