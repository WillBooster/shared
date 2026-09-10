# @willbooster/wb

`wb` offers a collection of reusable npm scripts, designed primarily for WillBooster Inc. but with potential utility for other projects as well.

## Supported Platforms

`wb` does not support Windows. Use it on macOS, Linux, or another POSIX-compatible environment.

## Usage

```
wb <command>

Commands:
  wb verify                      Verify project code
  wb buildIfNeeded               Build code if changes are detected
  wb check-env                   Verify that every fnox-declared environment
                                 variable and secret resolves for the current
                                 WB_ENV. Prefix scripts that write to remote
                                 environments with this command to fail fast on
                                 missing secrets.
  wb concurrently <commands...>  Run commands concurrently
  wb deploy                      Deploy a Cloudflare Workers app (vinext or
                                 plain Worker) to the WB_ENV environment:
                                 validate secrets, build, apply remote D1
                                 migrations, then deploy code and secrets
                                 atomically.
  wb dotenv [args..]             Load environment variables from fnox and run a
                                 command.
  wb gen-code                    Generate code for the current project
  wb gen-dev-vars [path]         Generate a .dev.vars file for `wrangler dev`
                                 from the environment variables loaded from fnox
                                 (plus WB_ENV and NEXT_PUBLIC_WB_ENV).
  wb gen-docker-env [path]       Generate a .docker.env file to bake into a
                                 Docker image, containing only the non-secret
                                 (plaintext default) values of fnox.toml for the
                                 selected WB_ENV. Secrets are never written;
                                 inject them at runtime from the deployment
                                 platform. The file is shell-sourceable dotenv
                                 (for a build-time `set -a && . ./.docker.env`
                                 and dotenv parsers), not for `docker
                                 --env-file`, which keeps quotes literally;
                                 runtime entrypoints must apply baked values
                                 only to keys the platform did not already set.
  wb kill-port <ports..>         Kill the processes listening on the given TCP
                                 ports
  wb kill-port-if-non-ci         Kill the process on the PORT environment
                                 variable (or the auto-selection preferred port)
                                 if non-CI.
  wb lint [files...]             Lint code
  wb maintenance <action>        Start or stop a lightweight maintenance page
                                 server. Example: wb maintenance start
  wb open-cli <target>           Open a URL or file in its default application
  wb optimizeForDockerBuild      Optimize configuration when building a Docker
                                 image
  wb prisma                      Run database commands. Use '--' to stop wb
                                 option parsing and forward the remaining
                                 arguments to Prisma. Drizzle projects use
                                 drizzle-kit. Example: wb prisma migrate-dev --
                                 --name init                       [aliases: db]
  wb railway-env                 Sync the environment variables declared for the
                                 current WB_ENV (resolved from fnox) to the
                                 Railway service, keeping fnox the single source
                                 of truth. Railway-managed keys (RAILWAY_*,
                                 NIXPACKS_*, CI) are never pushed.
  wb release [args..]            Run semantic-release (or
                                 multi-semantic-release) so that repositories
                                 using Bun isolated installs can publish to npm:
                                 reinstall with the hoisted linker (npm cannot
                                 walk Bun's isolated node_modules layout),
                                 rewrite `workspace:` ranges npm cannot parse,
                                 run the release, then restore the modified
                                 files. Extra arguments (e.g. `--debug`, after
                                 `--`) are forwarded to the release command.
  wb retry [command] [args...]   Retry the given command until it succeeds
  wb run [args..]                Load environment variables and run a script
                                 with the project runtime.
  wb setup                       Setup development environment. Environment
                                 variables are not loaded.
  wb setup-private-packages      Materialize private dependencies for Docker
                                 builds: copy git dependencies, reuse installed
                                 @willbooster-private/* registry packages whose
                                 exact-version or semver-range specifier the
                                 installed copy satisfies, and download the rest
                                 (auth via .npmrc / ~/.npmrc locally, or
                                 VERDACCIO_TOKEN on CI; dist-tag specifiers such
                                 as `latest` always download). The Dockerfile
                                 must COPY the generated directories (e.g. `COPY
                                 @willbooster/ @willbooster/` and `COPY
                                 @willbooster-private/ @willbooster-private/`)
                                 so the in-image install resolves the rewritten
                                 file: paths.
  wb slidev-check [files..]      Check selected Slidev decks, or all *.slidev.md
                                 decks when no files are given
  wb start [args..]              Start app. Use '--' to stop wb option parsing
                                 and forward the remaining arguments to the
                                 underlying app command. Example: wb start --
                                 --host 0.0.0.0
  wb test [targets...]           Test project. If you pass no arguments, it will
                                 run all tests. Use '--' to stop wb option
                                 parsing and forward the remaining flags to
                                 Playwright. Example: wb test -- --grep
                                 'uploaded image asset'
  wb test-on-ci                  Test project on CI with no options.
  wb tree-kill <pid> [signal]    Kill the given process and all descendants
  wb typecheck                   Run type checking. Environment variables are
                                 not loaded.
  wb tc                          Run type checking. Environment variables are
                                 not loaded.
  wb wait-on <resource>          Wait for an HTTP(S) URL or TCP port

Options:
      --cascade-env       Environment (fnox profile / mise env) to load
                          environment variables for. Preferred over
                          `cascade-node-env` and `auto-cascade-env`.    [string]
      --cascade-node-env  Same with --cascade-env=<NODE_ENV || "development">.
                          Preferred over `auto-cascade-env`.           [boolean]
      --auto-cascade-env  Same with --cascade-env=<WB_ENV || NODE_ENV ||
                          "development">.              [boolean] [default: true]
      --quiet-env         Suppress environment variable loading information.
                                                                       [boolean]
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

## Slidev checks

`wb slidev-check` checks slide text with textlint, then checks rendered Slidev decks.
It does not run installation, code linting, type checking, or tests.
Pass one or more files to check only those decks:

```sh
bun wb slidev-check slides/intro.slidev.md
bun wb slidev-check slides/intro.slidev.md slides/setup.slidev.md
bun wb slidev-check slides/intro.slidev.md --fix
```

With no files, it discovers all `*.slidev.md` files under the current project,
using the same exclusions as `wb verify --full`. Checks stop on the first failed
deck and return its exit code. `--fix` applies fixes provided by `slidev-check`;
textlint only reports problems and never edits text. Text errors stop the check
before rendering, including with `--fix`. `--dry-run` lists the text checks and
commands without running them. File paths are relative to
the working directory (or `--working-dir`). Page selection within a deck is not supported.

`wb verify` does not check Slidev decks. `wb verify --full` checks all discovered
decks before running tests, without applying fixes.

The bundled textlint rules check unmatched brackets/quotes, half-width kana,
decomposed Japanese dakuten, invalid control characters, and zero-width spaces
(U+200B). Sentence fragments, omitted final punctuation, long technical terms,
polite/plain style, sentence length, and cautious wording are allowed. No local
textlint configuration or extra textlint installation is needed; repository
`.textlintrc` files do not affect these slide checks.

Textlint checks Markdown content in visible slides, including `src:` imports,
and reports original file paths, lines, columns, and rule names. Slidev frontmatter,
comments/speaker notes, and code are excluded. Parsing uses the standard Markdown
textlint plugin; raw HTML blocks, component attributes, and dynamically generated
text are not checked. Keep prose in Markdown for coverage. Rule-specific exclusions
(such as quoted text) also apply.
