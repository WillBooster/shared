# @willbooster/shared-lib-node

## Purpose

WillBooster tools and servers share one tested implementation of process, file-system, and environment-variable handling instead of each writing its own.

## Goals

- Child processes started through this package never outlive the command that started them.
