# @willbooster/wb

`wb` offers a collection of reusable npm scripts, designed primarily for WillBooster Inc. but with potential utility for other projects as well.

## Supported Platforms

`wb` does not support Windows. Use it on macOS, Linux, or another POSIX-compatible environment.

## Usage

```
wb <command>

Commands:
  wb verify [targets...]         Verify project code
  wb buildIfNeeded               Build code if changes are detected
  wb check-env                   Verify that every fnox-declared environment
                                 variable and secret resolves for the current
                                 WB_ENV. Prefix scripts that write to remote
                                 environments with this command to fail fast on
                                 missing secrets.
  wb code-gauge [target]         Print code-gauge errors and warnings without
                                 failing
  wb concurrently <commands...>  Run commands concurrently
  wb deploy                      Deploy to the WB_ENV environment. A Cloudflare
                                 Workers app (vinext or plain Worker): validate
                                 secrets, build, apply remote D1 migrations,
                                 then deploy code and secrets atomically. A
                                 Railway service (.railway/railway.ts): check
                                 the IaC plan, sync fnox variables, apply the
                                 plan, then railway up and wait until the
                                 created deployment succeeds; --dry-run only
                                 checks the plan of every environment.
  wb dotenv [args..]             Load environment variables from fnox and run a
                                 command.
  wb gc                          Remove stale temporary files, worktrees, and
                                 build artifacts: under the ghq root locally, or
                                 stale job workspaces on a self-hosted CI
                                 runner.
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
                                 Before running semantic-release (not
                                 multi-semantic-release), fail unless `npm
                                 whoami` authenticates against each registry
                                 other than npmjs.org that @semantic-release/npm
                                 publishes to, or when those registries cannot
                                 be determined. When semantic-release fails
                                 after pushing the version tag and the run can
                                 establish that nothing was published, delete
                                 the tag and its note and print how to release
                                 the version again; otherwise keep the tag and
                                 print the manual recovery. With the
                                 @willbooster/wb/release-plugin semantic-release
                                 plugin, first complete a release that a failed
                                 run left pending.
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
                                 Playwright. Example: wb test --grep
                                 'uploaded image asset'
  wb test-on-ci                  Test project on CI.
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

## Disk cleanup

`wb gc` removes what is safe to lose and prints each removed path to stderr. `--dry-run` only lists them.

- Locally, under `$GHQ_ROOT` (default `~/ghq`, laid out as `<host>/<owner>/<repo>`):
  - `.tmp` entries unmodified for 7 days, then `git worktree prune`. An entry is kept when it contains Git-tracked files or, at any depth, a worktree whose detached HEAD has commits on no branch, remote-tracking branch, or tag, a repository with such a worktree anywhere, or a directory or repository that cannot be inspected. A path that cannot be removed is logged and skipped. Uncommitted changes in a stale entry are removed.
  - `node_modules` and directories marked by `CACHEDIR.TAG` (e.g., Cargo's `target`) up to three levels deep, unmodified for 30 days in a repository whose Git metadata (`index`, `HEAD`, `FETCH_HEAD`, `logs/HEAD`) is also older than 30 days, except in the repository wb runs in.
- On a self-hosted CI runner: every job workspace (`<work>/<repo>`) other than the current one in which nothing was modified for 3 days. The runner's own `_`-prefixed directories are kept.
- Both: `mise prune --yes` and `mise cache prune`.

The directory wb runs in and its ancestors are never removed. Anything wb gc cannot inspect (an unreadable directory, a failed git check) is kept, and freshness counts it as modified.

Every other wb command starts `wb gc` once per interval from the outermost wb process:

- On a developer machine, once a day in the background when `WB_AUTO_GC` is truthy, logging to `~/.cache/wb/gc.log`.
- On a self-hosted CI runner (`RUNNER_ENVIRONMENT=self-hosted`), once an hour per work directory, synchronously, because the job end kills background processes. GitHub-hosted runners are skipped.

## Running relevant tests

Run `bun run verify`, then select test files or directories and optionally filter
case names with a regular expression:

```sh
bun wb test test/unit/example.test.ts --grep 'handles invalid input'
bun wb test test/e2e/example.spec.ts --grep 'uploads an image'
bun wb verify --full test/unit/example.test.ts --grep 'handles invalid input'
```

`--grep` applies to Bun, Vitest, and Playwright. With no paths, it filters both
unit and E2E tests, allowing suites with no matching cases to pass so later suites
can run. If no suite matches, the name-only run also passes. With explicit paths,
the runner decides the no-match outcome; Vitest can pass with every case skipped.
The command and verification summary show the filter and no-match policy. Read
the test output or verification log to confirm which cases ran.

Paths are relative to the package being tested; in a monorepo,
select the package with `-w packages/example`. Use paths under `test/unit/`,
`test/e2e/`, or `test/debug/` to select the corresponding suite.

`wb verify --full` retains all verification steps and filters only its tests.
`verify` requires `--full` when test paths or `--grep` are supplied, and rejects
arguments after `--`; pass selections before the separator.
Without filters, test execution is unchanged. Filtered E2E runs omit the
unfiltered `test/e2e-additional` script. Playwright-specific options still go
after `--` in `wb test`; supply the name filter only once, before `--`.
Use `--grep-invert` for inverse Playwright name filters across versions.

Before running Playwright against an app that wb starts itself (on CI, or without a `webServer`
block), wb waits until the app answers an HTTP request. The request goes to the path of the first
`webServer.url` in `playwright.config.ts` when that is a string or template literal ending in a
plain path (`/api/ping` for `` `${baseURL}/api/ping` ``), and to the root path otherwise.

When a test command of `wb test` or a phase of `wb test-on-ci` exits, wb sends `SIGTERM` to the
processes it started that are still running (e.g. a build that a timed-out test left behind) and
lists them. wb finds them by polling the process tree every second, so a process whose parent
exited within a second of starting it is not found.

## Verification

`wb verify` and `wb verify --full` are intended for coding agents. The log path is printed at startup.
Successful runs print the completed steps and their durations. Failures print the
failed step name, exit code, and its last 100 lines (at most 16 KiB), followed by
the full log path. Truncated output is marked; read the log for earlier details.

Output is saved as it arrives, before display filtering,
to `.wb/verify.log` or `.wb/verify-full.log` in the verified project. Each command
overwrites its previous log; `--dry-run` leaves logs untouched.

`wb test-on-ci` streams complete stdout and stderr, including with `--silent`, without saving a local log. Each phase reports its package, duration, and exit code. The final summary includes failed phases, their working directories, and rerun commands. `--dry-run` labels constructed commands with `Would run` and omits phase completion results. CI workflows own log storage and artifact uploads. `--max-minutes <n>` fails the run when the `unit`, `e2e`, and `post` phases of all packages take longer than `n` minutes in total, even when every test passed, and lists those phases from slowest to fastest. The `e2e` phase includes building and starting the app under test; the startup check and the Docker image build do not count.

A package whose `package.json` defines a `test/post` script gets a `post` phase: after the unit and E2E tests of every package pass, `wb test-on-ci` and `wb test` run the script of each such package through the package manager, including a package that has no such tests. Use it for a test suite the JavaScript runners cannot run, such as Gradle, Maven, or RSpec. The script cannot be filtered, so `wb test` and `wb verify --full` skip it when test paths, `--grep`, or Playwright arguments select tests.

For `wb verify` and `wb verify --full`, a log-write failure falls back to printing subsequent raw output. If a log cannot be completed, the command reports the log error and fails an otherwise successful run; an existing nonzero command exit status is preserved.

## Code-quality checks

`wb code-gauge` runs [`code-gauge check`](https://github.com/WillBooster/code-gauge#threshold-check-code-gauge-check)
on the project and prints every threshold violation as an error or a warning: functions and files
over a metric limit, and duplicated blocks. A path limits the check to that file or directory (a directory's
test files are skipped, so a directory holding only test files is reported as unchecked, while a
file named as the path is checked even when it is a test file), and
`--base <ref>` to what the working tree changed since the merge-base with `<ref>`, in which case a
path without a changed file to check prints nothing. The command
always exits with 0, including when there are errors or the check cannot complete.

```sh
bun wb code-gauge
bun wb code-gauge packages/app/src
bun wb code-gauge --base origin/HEAD
```

`wb verify` and `wb verify --full` run the same check as their `code-gauge` step and print the
violations after the recap: the totals per level, how many are in code changed since the merge-base
with `origin/HEAD`, and at most 10 violations: those in the changed code first, then the rest, each
group with its errors before its warnings. A limit milder than its line's level names its own, as in
`error: ... function cognitive complexity 56 (max 30; largest parts L12-31 19, L33-40 isLegacy 8), function ncss 41 (warning max 30)`,
where the largest parts are the lines adding the most to the cognitive complexity. The step never
fails verification.

wb uses its own `code-gauge` and code-gauge's default thresholds; a `code-gauge.config.json` in the
repository overrides them.

## Japanese spacing in Markdown

`wb lint --format` (and so the pre-commit hook and `wb verify`) removes the spaces between Japanese
and half-width alphanumeric characters in the plain text of Markdown paragraphs, lists, tables, and
inline links, e.g. `この 2 つの LLM` becomes `この2つのLLM`, before `bun fmt` formats them. Everything
else keeps its spacing: code, blockquotes (which often cite external text verbatim), headings (whose
anchors links must keep matching), reference links (whose text must keep matching their
definitions), image alt text, HTML tags and their attributes, HTML blocks without blank lines, and
link titles, as well as the spaces next to inline code, outside bold or italic spans, and around
half-width parentheses. Text between HTML tags that a blank line separates from them (e.g. inside
`<details>`) is a paragraph and gets fixed. It covers the `*.md` files that Git tracks or does not
ignore, except test fixtures and the paths matched by a `.textlintignore` in any directory, with
gitignore syntax relative to that directory. It fixes text only and never fails `wb lint`.

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

The bundled textlint rules check half-width kana, invalid control characters,
zero-width spaces (U+200B), and Chinese or Korean text mixed into Japanese. Numeric inch marks, sentence fragments, omitted final punctuation, long technical terms,
polite/plain style, sentence length, and cautious wording are allowed. No local
textlint configuration or extra textlint installation is needed; repository
`.textlintrc` files do not affect these slide checks.

Textlint checks Markdown content in visible slides, including `src:` imports
within the workspace root or deck directory, and reports original file paths,
lines, columns, and rule names. Slidev's parser rejects import paths outside those
roots before reading them. This check compares paths without resolving symlink
targets. Slidev frontmatter,
comments/speaker notes, and code are excluded. Parsing uses the standard Markdown
textlint plugin; raw HTML blocks and HTML tag attributes are checked only for Chinese
or Korean text, excluding `<code>`, `<pre>`, `<script>`, and `<style>` elements. Slidev-specific
syntax is not interpreted: Vue expressions and MDC attributes may be checked
when the Markdown parser treats their source as prose (for example,
`{{ "ﾃｽﾄ" }}` or `[visible]{title="ﾃｽﾄ"}`). Half-width kana is checked in plain paragraph and list text, but not in headings
or bold/italic spans or blockquotes. The other rules also inspect headings and
blockquotes. Markdown coverage is not exhaustive.
