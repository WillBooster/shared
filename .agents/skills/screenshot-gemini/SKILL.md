---
name: screenshot-gemini
description: Run Gemini CLI to take a screenshot for a specific page.
allowed-tools: Bash(bunx:*)
---

# Screenshot workflow

1. Run the following command from the repository root with 1 hour timeout: `bunx @willbooster/agent-skills@latest screenshot --agent gemini <initial-url> <page-name> <description>`
   - `<initial-url>`: Initial URL to open before navigating
   - `<page-name>`: Page name to navigate to from the initial page
   - `<description>`: Description of the part to capture in the screenshot
2. Report the screenshot file path returned by the agent.
