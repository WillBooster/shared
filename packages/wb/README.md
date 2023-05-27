# wb

`wb` offers a collection of reusable npm scripts,
designed primarily for WillBooster Inc. but with potential utility for other projects as well.

## Usage

```
wb <command>

Commands:
  wb setup                   Setup development environment
  wb buildIfNeeded           Build code if changes are detected
  wb optimizeForDockerBuild  Optimize configuration when building a Docker image
  wb prisma                  Run prisma commands
  wb start                   Start app
  wb test                    Test project
  wb typecheck               Run type checking

Options:
      --version      Show version number                               [boolean]
  -e, --env          .env files to be loaded.                            [array]
  -w, --working-dir  A working directory                                [string]
      --help         Show help                                         [boolean]
```
