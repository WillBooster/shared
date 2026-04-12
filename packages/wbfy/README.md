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

1. `yarn dlx @willbooster/wbfy <project directory>`
