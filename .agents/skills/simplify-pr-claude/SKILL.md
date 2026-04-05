---
name: simplify-pr-claude
description: Use Claude Code to simplify the current pull request by safely reducing unnecessary scope, complexity, and noise while preserving the intended outcome.
allowed-tools: Bash(bunx:*)
---

# PR simplification workflow

1. Run the following command from the repository root with 1 hour timeout: `bunx @willbooster/agent-skills@latest simplify --agent claude`
2. Report on the simplification results.
