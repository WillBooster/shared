[ -d node_modules ] || bun install --frozen-lockfile
bun wb lint --quiet
