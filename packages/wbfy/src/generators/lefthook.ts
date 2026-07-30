// oxlint-disable eslint-plugin-import/no-named-as-default-member -- Namespace YAML calls make dump usage clearer.
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { logger } from '../logger.js';
import { fsUtil } from '../utils/fsUtil.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { getGenI18nTsCommand } from '../utils/genI18nTs.js';
import { doesContainJava, doesContainJsOrTs } from '../utils/packageCapabilities.js';
import { spawnSync } from '../utils/spawnUtil.js';

import { generateScripts } from './packageJson.js';

interface LefthookSettings {
  glob_matcher: 'doublestar';
  'post-merge': {
    jobs: LefthookJob[];
  };
  'pre-commit': {
    jobs: LefthookJob[];
  };
  'pre-push': {
    jobs: LefthookJob[];
  };
}

interface LefthookJob {
  name: string;
  glob?: string;
  run?: string;
  script?: string;
  runner?: 'bash';
  stage_fixed?: true;
}

const baseSettings: Omit<LefthookSettings, 'pre-commit'> = {
  glob_matcher: 'doublestar',
  'post-merge': {
    jobs: [
      {
        name: 'prepare',
        script: 'prepare.sh',
        runner: 'bash',
      },
    ],
  },
  'pre-push': {
    jobs: [
      {
        name: 'check',
        script: 'check.sh',
        runner: 'bash',
      },
    ],
  },
};

const preCommitSettings: LefthookSettings['pre-commit'] = {
  jobs: [
    {
      name: 'cleanup',
      glob: '',
      run: '',
      stage_fixed: true,
    },
    {
      name: 'check-migrations',
      glob: '**/migration.sql',
      run: `
failed=0
# Lefthook expands {staged_files} as shell-escaped args, so paths with spaces stay intact.
for file in {staged_files}; do
  if grep -q 'Warnings:' "$file"; then
    echo "Migration SQL file ($file) contains warnings! Please solve the warnings and commit again."
    failed=1
  fi
done
exit "$failed"
`.trim(),
    },
    {
      // bun records an absolute `resolved` URL for an already-locked package whenever the
      // configured registry does not serve the tarball host in the package metadata — which is
      // exactly what the Takumi Guard proxy does. So an install run with Guard as the default
      // registry (CI, or a developer who put it in ~/.npmrc) bakes npm.flatt.tech URLs into
      // bun.lock, and committing them pins a SHARED lockfile to one environment's mirror: every
      // later install downloads through the proxy, and a cold-cache install fails outright with
      // 401 for anyone whose npmrc carries a registry.npmjs.org token, because bun sends the
      // default registry's credentials to whatever host the lockfile names. Guard coverage does
      // not depend on these URLs — with an empty `resolved`, bun derives the download URL from
      // the configured registry — so strip them. Only the Guard host is stripped: a scoped
      // registry such as Verdaccio legitimately records its own URL for private packages.
      // Staging a DELETION of bun.lock leaves no file for inspection, so Lefthook skips this job
      // rather than passing a missing path to the loop (verified); the rewrite therefore cannot
      // resurrect a deleted lockfile as an empty file.
      name: 'normalize-bun-lockfile',
      glob: 'bun.lock',
      run: `
# Abort on any failure: a partially written temp file must never replace the lockfile.
set -e
# Lefthook expands {staged_files} as shell-escaped args, so paths with spaces stay intact.
for file in {staged_files}; do
  # A sibling temp file makes the replacement an atomic same-directory rename, and \`cp -p\` gives
  # it the lockfile's original mode (mktemp alone creates 0600, and git tracks only the executable
  # bit, so that would change silently). The name must stay unpredictable and be created by
  # mktemp: a repository-committed symlink at a fixed sibling path would otherwise be followed by
  # \`cp\` and the redirection, and the \`mv\` would then turn bun.lock into that symlink.
  normalized="$(mktemp "$file.wbfy-normalizing.XXXXXX")"
  trap 'rm -f "$normalized"' EXIT
  cp -p "$file" "$normalized"
  # Anchored to \`", \` so only a registry entry's \`resolved\` slot is cleared (mirroring
  # reusable-workflows and wb's normalizeBunLockfile): a DIRECT tarball dependency carries the same
  # host in the workspace descriptor and the package tuple's first element, which must survive.
  sed -E 's#(", )"https://npm\\.flatt\\.tech/[^"]*"#\\1""#g' "$file" > "$normalized"
  if ! cmp -s "$file" "$normalized"; then
    mv "$normalized" "$file"
    echo "Removed Takumi Guard proxy URLs from $file so the lockfile stays registry-agnostic."
  fi
  rm -f "$normalized"
done
`.trim(),
      stage_fixed: true,
    },
    {
      // Only willbooster-configs gets this job: every other repository's renovate.jsonc merely
      // extends the shared preset, and the validator does not resolve remote presets, so running it
      // there would validate two lines and catch nothing. `--no-global` validates the preset as a
      // repo config instead of a self-hosted global config, and `@latest` keeps npm from silently
      // installing an ancient Renovate that cannot even parse JSONC when the local Node lags behind.
      // Staging a deletion of renovate.jsonc leaves no file for inspection, so Lefthook skips this
      // job instead of running the validator on a missing path — deliberately, because deleting the
      // shared preset is not an operation this hook needs to guard.
      name: 'validate-renovate-config',
      glob: 'renovate.jsonc',
      run: 'npx --yes --package renovate@latest -- renovate-config-validator --strict --no-global {staged_files}',
    },
  ],
};

const scripts = {
  postMerge: `
#!/bin/bash

changed_files="$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD)"

run_if_changed() {
  if echo "$changed_files" | grep --quiet -E "$1"; then
    eval "$2"
  fi
}
`.trim(),
};

export async function generateLefthookUpdatingPackageJson(
  config: PackageConfig,
  allConfigs: PackageConfig[] = [config]
): Promise<void> {
  return logger.functionIgnoringException('generateLefthookUpdatingPackageJson', async () => {
    await core(config, allConfigs);
  });
}

async function core(config: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  const dirPath = path.resolve(config.dirPath, '.lefthook');
  const huskyDirPath = path.resolve(config.dirPath, '.husky');
  const hasHuskyDir = fs.existsSync(huskyDirPath);
  const { lint } = generateScripts(config, {});
  const settings: Partial<LefthookSettings> = {
    ...baseSettings,
    'pre-commit': {
      jobs: getPreCommitJobs(config),
    },
  };
  if (!lint) {
    delete settings['pre-push'];
  }
  await Promise.all([
    fsUtil.writeFileConfined(
      path.join(config.dirPath, 'lefthook.yml'),
      yaml.dump(settings, {
        lineWidth: -1,
        noCompatMode: true,
        styles: {
          '!!null': 'empty',
        },
      })
    ),
    fs.promises.rm(dirPath, { force: true, recursive: true }),
  ]);
  if (hasHuskyDir) {
    await Promise.all([
      fs.promises.rm(huskyDirPath, { force: true, recursive: true }),
      fs.promises.rm(path.resolve(config.dirPath, '.huskyrc.json'), { force: true }),
    ]);
    spawnSync('git', ['config', '--unset', 'core.hooksPath'], config.dirPath);
  }

  if (lint) {
    const prePush = getPrePushScript(config);
    fs.mkdirSync(path.join(dirPath, 'pre-push'), { recursive: true });
    await fs.promises.writeFile(path.join(dirPath, 'pre-push', 'check.sh'), prePush + '\n', {
      mode: 0o755,
    });
  }
  const postMergeCommand = `${scripts.postMerge}\n\n${generatePostMergeCommands(config, allConfigs).join('\n')}\n`;
  fs.mkdirSync(path.join(dirPath, 'post-merge'), { recursive: true });
  await fs.promises.writeFile(path.resolve(dirPath, 'post-merge', 'prepare.sh'), postMergeCommand, {
    mode: 0o755,
  });
}

function getPrePushScript(config: PackageConfig): string {
  // Bun repos receive wb as part of wbfy's managed toolchain, so generate the
  // final hook command on the first run instead of changing it on the second.
  const quietLintCommand = 'bun wb lint --quiet';
  // No separate typecheck step needed — the lint command already includes typechecking.
  if (config.repository?.startsWith('github:WillBoosterLab/')) {
    return `
#!/bin/bash

if [ $(git branch --show-current) = "main" ] && [ $(git config user.email) != "exkazuu@gmail.com" ]; then
  echo "************************************************"
  echo "*** Don't push main branch directly. Use PR! ***"
  echo "************************************************"
  exit 1
fi

${quietLintCommand}
`.trim();
  }
  return quietLintCommand;
}

function getPreCommitJobs(config: PackageConfig): LefthookJob[] {
  return preCommitSettings.jobs
    .filter((job) => job.name !== 'validate-renovate-config' || config.isWillBoosterConfigs)
    .map((job) =>
      job.name === 'cleanup'
        ? {
            ...job,
            glob: getCleanupGlobs(config),
            run: getCleanupCommand(config),
          }
        : job
    );
}

function getCleanupGlobs(config: PackageConfig): string {
  // Let `wb lint --format` decide whether Prettier is available; the hook
  // still needs to trigger when adding the first prettier-only file.
  const supportedExtensions = [...extensions.prettierOnly];
  if (doesContainJsOrTs(config)) {
    supportedExtensions.push(...extensions.oxfmt, ...extensions.oxlint);
  }
  if (config.doesContainPoetryLock || config.doesContainUvLock) {
    supportedExtensions.push('py');
  }
  if (config.doesContainPubspecYaml) {
    supportedExtensions.push('dart');
  }
  const filteredExtensions = [...new Set(supportedExtensions)].toSorted();
  return `**/*.{${filteredExtensions.join(',')}}`;
}

function getCleanupCommand(config: PackageConfig): string {
  if (hasLocalWbWorkspace(config)) {
    return String.raw`
# Lefthook expands {staged_files} as shell-escaped args, so paths with spaces stay intact.
bun run --cwd packages/wb start --working-dir "$(git rev-parse --show-toplevel)" lint --fix --format -- {staged_files}
`.trim();
  }
  // Python-only Bun repos install wb for shared scripts but not Oxlint, so
  // staged-file hooks must use the language-specific formatter path below.
  const canUseWbForStagedFiles = doesContainJsOrTs(config) || doesContainJava(config);
  if (canUseWbForStagedFiles) {
    return `
# Lefthook expands {staged_files} as shell-escaped args, so paths with spaces stay intact.
bun wb lint --fix --format -- {staged_files}
`.trim();
  }

  const oxlintPattern = extensions.oxlint.map((extension) => String.raw`\.${extension}$`).join('|');
  const oxfmtPattern = extensions.oxfmt.map((extension) => String.raw`\.${extension}$`).join('|');
  const prettierPattern = extensions.prettierOnly.map((extension) => String.raw`\.${extension}$`).join('|');
  const hasJsOrTs = doesContainJsOrTs(config);
  const hasJava = doesContainJava(config);

  return String.raw`
# Lefthook expands {staged_files} as shell-escaped args, so paths with spaces stay intact.
${hasJsOrTs ? String.raw`oxlint_files="$(printf '%s\n' {staged_files} | grep -E '(${oxlintPattern})' || true)"` : ''}
${hasJsOrTs ? String.raw`oxfmt_files="$(printf '%s\n' {staged_files} | grep -E '(${oxfmtPattern})' | grep -v -E '(^|/)package\.json$' || true)"` : ''}
${hasJava ? String.raw`prettier_files="$(printf '%s\n' {staged_files} | grep -E '(${prettierPattern})' || true)"` : ''}
package_json_files="$(printf '%s\n' {staged_files} | grep -E '(^|/)package\.json$' || true)"
${hasPythonPackageManager(config) ? String.raw`python_files="$(printf '%s\n' {staged_files} | grep -E '\.py$' || true)"` : ''}
${config.doesContainPubspecYaml ? String.raw`dart_files="$(printf '%s\n' {staged_files} | grep -E '\.dart$' | grep -v 'generated' | grep -v '\.freezed\.dart$' | grep -v '\.g\.dart$' || true)"` : ''}

${
  hasJsOrTs
    ? String.raw`
if [ -n "$oxfmt_files" ]; then
  node node_modules/.bin/oxfmt --write --no-error-on-unmatched-pattern '!**/package.json' $oxfmt_files
fi
`
    : ''
}
${
  hasJava
    ? String.raw`if [ -n "$prettier_files" ]; then
  node node_modules/.bin/prettier --cache --write --ignore-unknown -- $prettier_files
fi`
    : ''
}
${
  hasJsOrTs
    ? String.raw`
if [ -n "$oxlint_files" ]; then
  node node_modules/.bin/oxlint --fix $oxlint_files
fi
`
    : ''
}
if [ -n "$package_json_files" ]; then
  node node_modules/.bin/sort-package-json -- $package_json_files
fi
${
  hasPythonPackageManager(config)
    ? `if [ -n "$python_files" ]; then
  ${getPythonRunner(config)} isort --profile black --filter-files $python_files
  ${getPythonRunner(config)} black $python_files
  ${getPythonRunner(config)} flake8 $python_files
fi`
    : ''
}
${
  config.doesContainPubspecYaml
    ? `if [ -n "$dart_files" ]; then
  dart format $dart_files
fi`
    : ''
}
`.trim();
}

function hasLocalWbWorkspace(config: PackageConfig): boolean {
  if (!config.isRoot) return false;

  const localWbPackageJsonPath = path.resolve(config.dirPath, 'packages', 'wb', 'package.json');
  if (!fs.existsSync(localWbPackageJsonPath)) return false;

  try {
    const packageJson = JSON.parse(fs.readFileSync(localWbPackageJsonPath, 'utf8')) as { name?: string };
    return packageJson.name === '@willbooster/wb';
  } catch {
    return false;
  }
}

function generatePostMergeCommands(config: PackageConfig, allConfigs: PackageConfig[]): string[] {
  const postMergeCommands: string[] = [];
  // Always emit the mise hook: every managed repository receives mise.toml from generateMiseToml
  // in the same run, and gating on a pre-run hasVersionSettings snapshot would omit the hook on
  // the first migration run (non-idempotent output).
  const toolsChangedPattern = String.raw`(mise\.toml|\.mise\.toml|\.tool-versions|\..+-version)`;
  postMergeCommands.push(String.raw`run_if_changed "${toolsChangedPattern}" "mise install"`);
  const installCommand = 'bun install';
  // Do NOT add `.vinext` here: it holds only vinext's content-hashed font cache and the dev
  // server's lock file (deleting the lock disables the duplicate-dev-server guard for a running
  // server). vinext's build output goes to `dist/`, and Vite's dependency cache is handled by
  // the separate install-layout hook below.
  // Scan every workspace config (not just the root): in a monorepo the app usually lives in
  // packages/<app> or apps/<app>, and the cache directories are workspace-relative.
  const nextCacheDirPaths = collectWorkspaceRelativeDirPaths(
    config,
    allConfigs,
    (workspaceConfig) => workspaceConfig.depending.blitz || workspaceConfig.depending.next,
    '.next'
  );
  const rmNextDirectories =
    nextCacheDirPaths.length > 0 ? ` && rm -Rf -- ${nextCacheDirPaths.map(quoteForEvaluatedShell).join(' ')}` : '';
  // Bun does not relink an existing isolated tree when globalStore/linker settings change. Clean
  // every workspace install first so contributors pulling a bunfig change get the intended layout.
  const nodeModulesDirPaths = collectWorkspaceRelativeDirPaths(config, allConfigs, () => true, 'node_modules');
  postMergeCommands.push(
    String.raw`run_if_changed "bunfig\.toml" "rm -Rf -- ${nodeModulesDirPaths.map(quoteForEvaluatedShell).join(' ')}"`
  );
  // bun.lock-only merges (Renovate lockfile maintenance), bunfig.toml / .npmrc changes (linker,
  // registry, hoisting), and patch edits all change the installed tree without touching package.json.
  postMergeCommands.push(
    String.raw`run_if_changed "(package\.json|bun\.lock|bunfig\.toml|\.npmrc|patches/)" "${installCommand}${rmNextDirectories}"`
  );
  // Vite's dependency cache in node_modules/.vite self-invalidates on lockfile / patches /
  // config / NODE_ENV changes (see Vite's dep pre-bundling docs), so the residual stale case is
  // install-layout changes (bunfig.toml linker, .npmrc): they change the installed tree without
  // touching the lockfile, and they are absent from Vite's cache key.
  const rmViteCacheDirectories = collectWorkspaceRelativeDirPaths(
    config,
    allConfigs,
    (workspaceConfig) => workspaceConfig.depending.vinext || workspaceConfig.depending.vite,
    'node_modules/.vite'
  );
  if (rmViteCacheDirectories.length > 0) {
    postMergeCommands.push(
      String.raw`run_if_changed "(bunfig\.toml|\.npmrc)" "rm -Rf -- ${rmViteCacheDirectories.map(quoteForEvaluatedShell).join(' ')}"`
    );
  }
  if (config.doesContainPoetryLock) {
    postMergeCommands.push(String.raw`run_if_changed "poetry\.lock" "poetry install"`);
  }
  if (config.doesContainUvLock) {
    postMergeCommands.push(String.raw`run_if_changed "uv\.lock" "uv sync --frozen"`);
  }
  // Blitz repositories deliberately get the same wb-driven prisma commands as everyone else:
  // the blitz CLI's codegen patches the installed next package in place, which must never run
  // under Bun's shared global store. Yarn-era Blitz repos get their route manifest from
  // `wb gen-code`'s `blitz codegen` step, and current wb routes only `wb prisma seed` through
  // the blitz CLI, only for non-Bun repos (see packages/wb/src/scripts/prismaScripts.ts); the
  // post-merge hooks stay wb-driven because `prisma deploy`/`generate` need no blitz loader.
  if (config.depending.prisma) {
    postMergeCommands.push(
      String.raw`run_if_changed ".*\.prisma" "node node_modules/.bin/wb prisma deploy"`,
      String.raw`run_if_changed ".*\.prisma" "node node_modules/.bin/wb prisma generate"`
    );
  }
  const genI18nTsCommand = getGenI18nTsCommand(config, config.packageJson?.scripts);
  if (genI18nTsCommand) {
    // gen-i18n-ts outputs are commonly ignored, so post-merge regenerates them after pulled resource changes.
    postMergeCommands.push(String.raw`run_if_changed "(^|/)i18n/.*\.json$" "${genI18nTsCommand}"`);
  }
  return postMergeCommands;
}

// The generated command passes through TWO shell parsing stages: the prepare.sh line parses it as
// a double-quoted argument (processing \, `, $ and " immediately), and run_if_changed then eval's
// it (word-splitting and globbing). An unquoted path containing spaces (e.g. `apps/my app/.next`)
// would word-split into unrelated rm targets, and `$`/backtick would expand at the first stage.
// So: single-quote for the eval stage, then backslash-escape the double-quote-context specials.
function quoteForEvaluatedShell(filePath: string): string {
  const evalQuoted = `'${filePath.replaceAll("'", String.raw`'\''`)}'`;
  return evalQuoted.replaceAll(/[\\`$"]/gu, String.raw`\$&`);
}

/**
 * The workspace-relative directories (root first, deduplicated, `<subDirName>` appended) of every
 * workspace whose config matches the predicate. The hook script runs at the repository root, so
 * paths are relative to the root config's directory.
 */
function collectWorkspaceRelativeDirPaths(
  rootConfig: PackageConfig,
  allConfigs: PackageConfig[],
  predicate: (config: PackageConfig) => boolean,
  subDirName: string
): string[] {
  return [
    ...new Set(
      allConfigs
        .filter((config) => predicate(config))
        .map((config) => {
          const relativeDirPath = path.relative(rootConfig.dirPath, config.dirPath).replaceAll('\\', '/');
          return relativeDirPath ? path.posix.join(relativeDirPath, subDirName) : subDirName;
        })
    ),
  ].toSorted();
}

function hasPythonPackageManager(config: PackageConfig): boolean {
  return config.doesContainPoetryLock || config.doesContainUvLock;
}

function getPythonRunner(config: PackageConfig): 'poetry run' | 'uv run' {
  return config.doesContainUvLock ? 'uv run' : 'poetry run';
}
