# wb

`wb` provides a set of reusable npm scripts.
Though we develop `wb` for WillBooster repositories, we believe it is useful for other repositories.

## Usage

```
wb <command>

Commands:
  wb setup                   Setup development environment
  wb buildIfNeeded           Build code if changes are detected
  wb optimizeForDockerBuild  Optimize configuration when building a Docker image
  wb db                      Run db commands
  wb start                   Start app
  wb test                    Test project
  wb typecheck               Run type checking

Options:
      --version      Show version number                               [boolean]
  -e, --env          .env files to be loaded.                            [array]
  -w, --working-dir  A working directory                                [string]
      --help         Show help                                         [boolean]
```
