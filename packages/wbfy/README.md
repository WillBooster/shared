# wbfy

[![Test](https://github.com/WillBooster/shared/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/shared/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

:books::rocket: A tool for applying WillBooster's conventional configurations to npm packages

## Motivation

There are some resources for creating a project with conventional configurations like [Yeoman](https://yeoman.io/), GitHub's Template repository, and starter-kit repositories.
However, we sometimes faced the cases where we wanted to apply conventional configurations to an existing repository, so we've launch this tool!

## Philosophy

This tool must keep idempotency, i.e., it always yields the same result when a user applies this tool to a project even multiple times.

## How to Use

`bunx @willbooster/wbfy` is the canonical package; `bunx wbfy` runs the same CLI through a wrapper that depends on the exact same version of `@willbooster/wbfy`. The wrapper is published only after npm makes that version installable, so it skips a version npm holds for over an hour, and `wbfy@latest` then stays on the previous release.

1. `bunx @willbooster/wbfy <project directory>`
2. `bunx @willbooster/wbfy generate-user-agent-configs` to overwrite your user-level agent instruction files (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`) with the organization's fixed content and merge the organization's settings (disabling Claude Code's commit/PR attribution, Antigravity CLI's telemetry, and Claude Code's and Gemini CLI's auto memory) into `~/.claude/settings.json`, `~/.gemini/antigravity-cli/settings.json`, and `~/.gemini/settings.json`

Generated standalone test workflows stream output. Log capture and upload are enabled together. Set the repository Actions variable `UPLOAD_TEST_LOG` to `true` to save and upload a log after success or failure with 14-day retention. Enable this only for secret-free test output: artifact files do not receive GitHub console secret masking. Artifact names include the OS, job check-run ID, and run attempt so each job and rerun retains its own log.
