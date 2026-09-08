# @willbooster/wb

`wb` offers a collection of reusable npm scripts, designed primarily for WillBooster Inc. but with potential utility for other projects as well.

## Supported Platforms

`wb` does not support Windows. Use it on macOS, Linux, or another POSIX-compatible environment.

## Usage

```
wb <command>

Commands:
  wb buildIfNeeded              Build code if changes are detected
  wb kill-port <ports..>        Kill the processes listening on the given TCP
                                ports
  wb kill-port-if-non-ci        Kill the process on the PORT environment
                                variable (or the auto-selection preferred port)
                                if non-CI.
  wb lint [files...]            Lint code
  wb maintenance <action>       Start or stop a lightweight maintenance page
                                server.
                                Example: wb maintenance start
  wb open-cli <target>          Open a URL or file in its default application
  wb optimizeForDockerBuild     Optimize configuration when building a Docker
                                image
  wb prisma                     Run database commands              [aliases: db]
  wb retry [command] [args...]  Retry the given command until it succeeds
  wb setup                      Setup development environment. Environment
                                variables are not loaded.
  wb setup-private-packages     Materialize private git and registry
                                dependencies for Docker builds (installed
                                registry packages satisfying an exact version
                                or semver range are reused; dist-tag
                                specifiers and missing packages are
                                downloaded)
  wb start [args..]             Start app
  wb test [targets...]          Test project. If you pass no arguments, it will
                                run all tests.
  wb test-on-ci                 Test project on CI with no options.
  wb typecheck                  Run type checking. Environment variables are not
                                loaded.
  wb tc                         Run type checking. Environment variables are not
                                loaded.
  wb verify                    Verify project code; add --full to run tests
  wb wait-on <resource>         Wait for an HTTP(S) URL or TCP port

Options:
      --cascade-env       Environment (fnox profile / mise env) to load
                          environment variables for. Preferred over
                          `cascade-node-env` and `auto-cascade-env`.    [string]
      --cascade-node-env  Same with --cascade-env=<NODE_ENV || "development">.
                          Preferred over `auto-cascade-env`.           [boolean]
      --auto-cascade-env  Same with --cascade-env=<WB_ENV || NODE_ENV ||
                          "development">.              [boolean] [default: true]
  -v, --verbose           Whether to show verbose information          [boolean]
  -w, --working-dir       A working directory                           [string]
  -d, --dry-run, --dry    Whether to skip actual command execution     [boolean]
      --version           Show version number                          [boolean]
      --help              Show help                                    [boolean]
```

## Verification

`wb verify` and `wb verify --full` are intended for coding agents. The log path is printed at startup.
Successful runs print the completed steps and their durations. Failures print the
failed step name, exit code, and its last 100 lines (at most 16 KiB), followed by
the full log path. Truncated output is marked; read the log for earlier details.

Output is saved as it arrives, before display filtering,
to `.wb/verify.log` or `.wb/verify-full.log` in the verified project. Each command
overwrites its previous log; `--dry-run` leaves logs untouched.
