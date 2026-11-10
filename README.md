# shared

[![Test](https://github.com/WillBooster/shared/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/shared/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-21.6.1-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

:recycle: An npm package designed for reusing general code across multiple projects at WillBooster Inc.

## Purpose

Every WillBooster repository is developed, verified, and released the same way, so people and AI agents move between repositories without relearning each one.

## Goals

- An AI agent develops, verifies, and releases any WillBooster repository without repository-specific guidance from a person.
- A change to an organization convention reaches every repository through one `wbfy` run.
- Code that two or more WillBooster projects need exists once, in a `shared-lib` package.

## Non-goals

- Supporting repositories outside WillBooster and WillBoosterLab beyond best effort.
- Running on Windows.

## Documents

- [Rules that `wbfy` and `wb` expect of target repositories](docs/expected-repository-rules.md)
