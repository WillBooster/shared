# wbfy

[![Test](https://github.com/WillBooster/shared/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/shared/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

:books::rocket: A tool for applying WillBooster's conventional configurations to npm packages

## Purpose

Every WillBooster repository stays on the organization's current conventions without anyone configuring it by hand.

## Goals

- The agent instructions `wbfy` generates let an AI agent work in a repository without further guidance from a person.

## Non-goals

- Supporting repositories outside WillBooster and WillBoosterLab beyond best effort.
- Accepting hand-written, legacy, or third-party variants of the files `wbfy` generates.
- Running on Windows.

## Philosophy

This tool must keep idempotency, i.e., it always yields the same result when a user applies this tool to a project even multiple times.

## How to Use

Run with Bun >= 1.4.4 or Node.js >= 26 on macOS or Linux. mise must be on `PATH`. The target repository may still pin an older Bun: wbfy installs and activates the managed Node.js and Bun before dependency commands, then checks that the Bun CLI is at least 1.4.4. `bunx @willbooster/wbfy` uses its Bun entry point, including when the target repository still pins Node.js 24. To run the CLI with Node.js, invoke its `bin/wbfy.js` with `node`. After updating `mise.toml`, wbfy uses the pinned Node.js and Bun for dependency installation and cleanup.

`bunx @willbooster/wbfy` is the canonical package; `bunx wbfy` runs the same CLI through a wrapper that depends on the exact same version of `@willbooster/wbfy`. The wrapper is published only after npm makes that version installable, so it skips a version npm holds for over an hour, and `wbfy@latest` then stays on the previous release.

1. `bunx @willbooster/wbfy <project directory>`
2. `bunx @willbooster/wbfy generate-user-agent-configs` to overwrite your user-level agent instruction files (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`) and status line scripts (`~/.claude/statusline-command.sh`, `~/.gemini/antigravity-cli/statusline-command.sh`, which require `jq`) with the organization's fixed content and merge the organization's settings (disabling Claude Code's commit/PR attribution, Antigravity CLI's telemetry, and Claude Code's and Gemini CLI's auto memory, enabling those status lines, and registering `~/.agents/skills` for Antigravity CLI) into `~/.claude/settings.json`, `~/.gemini/antigravity-cli/settings.json`, `~/.gemini/config/skills.json`, and `~/.gemini/settings.json`

Generated standalone test workflows stream output. Log capture and upload are enabled together. Set the repository Actions variable `UPLOAD_TEST_LOG` to `true` to save and upload a log after success or failure with 14-day retention. Enable this only for secret-free test output: artifact files do not receive GitHub console secret masking. Artifact names include the OS, job check-run ID, and run attempt so each job and rerun retains its own log.
