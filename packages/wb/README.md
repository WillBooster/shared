# @willbooster/wb

`wb` offers a collection of reusable npm scripts, designed primarily for WillBooster Inc. but with potential utility for other projects as well.

## Usage

```
wb <command>

Commands:
  wb buildIfNeeded              Build code if changes are detected
  wb kill-port-if-non-ci        Kill the port specified by PORT environment
                                variable if non-CI.
  wb lint [files...]            Lint code on Bun
  wb optimizeForDockerBuild     Optimize configuration when building a Docker
                                image
  wb prisma                     Run prisma commands
  wb retry [command] [args...]  Retry the given command until it succeeds
  wb setup                      Setup development environment. .env files are
                                ignored.
  wb start [args..]             Start app
  wb test [targets...]          Test project. If you pass no arguments, it will
                                run all tests.
  wb test-on-ci                 Test project on CI with no options.
  wb typecheck                  Run type checking. .env files are ignored.
  wb tc                         Run type checking. .env files are ignored.

Options:
      --env               .env files to be loaded.                       [array]
      --cascade-env       Environment to load cascading .env files (e.g.,
                          `.env`, `.env.<environment>`, `.env.local` and
                          `.env.<environment>.local`). Preferred over
                          `cascade-node-env` and `auto-cascade-env`.    [string]
      --cascade-node-env  Same with --cascade-env=<NODE_ENV || "development">.
                          Preferred over `auto-cascade-env`.           [boolean]
      --auto-cascade-env  Same with --cascade-env=<WB_ENV || NODE_ENV ||
                          "development">.              [boolean] [default: true]
      --include-root-env  Include .env files in root directory if the project is
                          in a monorepo and --env option is not used.
                                                       [boolean] [default: true]
      --check-env         Check whether the keys of the loaded .env files are
                          same with the given .env file.
                                              [string] [default: ".env.example"]
  -v, --verbose           Whether to show verbose information          [boolean]
  -w, --working-dir       A working directory                           [string]
  -d, --dry-run, --dry    Whether to skip actual command execution     [boolean]
      --version           Show version number                          [boolean]
      --help              Show help                                    [boolean]
```
