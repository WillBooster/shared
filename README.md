---
purpose: People and AI agents work on any WillBooster repository without learning it first, because every repository follows the same conventions, runs the same commands, and shares the same code.
goals:
  - An AI agent develops, verifies, and releases in any WillBooster repository without repository-specific guidance from a person.
  - Every repository stays on the organization's current conventions without anyone configuring it by hand.
  - The same command does the same job in every repository, whatever its framework or deploy target.
  - Code that two or more WillBooster projects need exists once.
nonGoals:
  - Supporting repositories outside WillBooster and WillBoosterLab beyond best effort.
  - Running on Windows.
---

# shared

[![Test](https://github.com/WillBooster/shared/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/shared/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-21.6.1-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

:recycle: An npm package designed for reusing general code across multiple projects at WillBooster Inc.

## Documents

- [Rules that `wbfy` and `wb` expect of target repositories](docs/expected-repository-rules.md)
