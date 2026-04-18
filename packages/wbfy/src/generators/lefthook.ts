// oxlint-disable eslint-plugin-import/no-named-as-default-member -- Namespace YAML calls make dump usage clearer.
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { logger } from '../logger.js';
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

export async function generateLefthookUpdatingPackageJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateLefthookUpdatingPackageJson', async () => {
    await core(config);
  });
}

async function core(config: PackageConfig): Promise<void> {
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
    fs.promises.writeFile(
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
  const postMergeCommand = `${scripts.postMerge}\n\n${generatePostMergeCommands(config).join('\n')}\n`;
  fs.mkdirSync(path.join(dirPath, 'post-merge'), { recursive: true });
  await fs.promises.writeFile(path.resolve(dirPath, 'post-merge', 'prepare.sh'), postMergeCommand, {
    mode: 0o755,
  });
}

function getPrePushScript(config: PackageConfig): string {
  let lintCommand: string;
  if (config.isBun) {
    lintCommand = config.depending.wb ? 'bun --bun wb lint' : 'bun run lint';
  } else {
    lintCommand = config.depending.wb ? 'yarn wb lint' : 'yarn run lint';
  }
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

${lintCommand}
`.trim();
  }
  return lintCommand;
}

function getPreCommitJobs(config: PackageConfig): LefthookJob[] {
  return preCommitSettings.jobs.map((job) =>
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
  const supportedExtensions = doesContainJava(config) ? [...extensions.prettierOnly] : [];
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
yarn workspace @willbooster/wb start --working-dir "$(git rev-parse --show-toplevel)" lint --fix --format -- {staged_files}
`.trim();
  }
  if (config.isBun || config.depending.wb) {
    const packageManager = config.isBun ? 'bun' : 'yarn';
    return config.depending.wb
      ? `
# Lefthook expands {staged_files} as shell-escaped args, so paths with spaces stay intact.
${config.isBun ? 'bun --bun wb' : 'yarn wb'} lint --fix --format -- {staged_files}
`.trim()
      : `${packageManager} run format && ${packageManager} run lint-fix`;
  }

  const oxlintPattern = extensions.oxlint.map((extension) => String.raw`\.${extension}$`).join('|');
  const oxfmtPattern = extensions.oxfmt.map((extension) => String.raw`\.${extension}$`).join('|');
  const prettierPattern = extensions.prettierOnly.map((extension) => String.raw`\.${extension}$`).join('|');
  const hasJsOrTs = doesContainJsOrTs(config);
  const hasJava = doesContainJava(config);

  return String.raw`
# Lefthook expands {staged_files} as shell-escaped args, so paths with spaces stay intact.
${hasJsOrTs ? String.raw`oxlint_files="$(printf '%s\n' {staged_files} | grep -E '(${oxlintPattern})' || true)"` : ''}
${hasJsOrTs ? String.raw`oxfmt_files="$(printf '%s\n' {staged_files} | grep -E '(${oxfmtPattern})' || true)"` : ''}
${hasJava ? String.raw`prettier_files="$(printf '%s\n' {staged_files} | grep -E '(${prettierPattern})' || true)"` : ''}
package_json_files="$(printf '%s\n' {staged_files} | grep -E '(^|/)package\.json$' || true)"
${hasPythonPackageManager(config) ? String.raw`python_files="$(printf '%s\n' {staged_files} | grep -E '\.py$' || true)"` : ''}
${config.doesContainPubspecYaml ? String.raw`dart_files="$(printf '%s\n' {staged_files} | grep -E '\.dart$' | grep -v 'generated' | grep -v '\.freezed\.dart$' | grep -v '\.g\.dart$' || true)"` : ''}

${
  hasJsOrTs
    ? String.raw`
if [ -n "$oxfmt_files" ]; then
  node node_modules/.bin/oxfmt --write --no-error-on-unmatched-pattern $oxfmt_files
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

function generatePostMergeCommands(config: PackageConfig): string[] {
  const postMergeCommands: string[] = [];
  if (config.hasVersionSettings) {
    const toolsChangedPattern = String.raw`(mise\.toml|\.mise\.toml|\.tool-versions|\..+-version)`;
    postMergeCommands.push(String.raw`run_if_changed "${toolsChangedPattern}" "mise install"`);
  }
  const installCommand = config.isBun ? 'bun install' : 'yarn';
  const rmNextDirectory = config.depending.blitz || config.depending.next ? ' && rm -Rf .next' : '';
  postMergeCommands.push(String.raw`run_if_changed "package\.json" "${installCommand}${rmNextDirectory}"`);
  if (config.doesContainPoetryLock) {
    postMergeCommands.push(String.raw`run_if_changed "poetry\.lock" "poetry install"`);
  }
  if (config.doesContainUvLock) {
    postMergeCommands.push(String.raw`run_if_changed "uv\.lock" "uv sync --frozen"`);
  }
  if (config.depending.blitz) {
    postMergeCommands.push(
      String.raw`run_if_changed ".*\.prisma" "node node_modules/.bin/blitz prisma migrate deploy"`,
      String.raw`run_if_changed ".*\.prisma" "node node_modules/.bin/blitz prisma generate"`,
      String.raw`run_if_changed ".*\.prisma" "node node_modules/.bin/blitz codegen"`
    );
  } else if (config.depending.prisma) {
    postMergeCommands.push(
      String.raw`run_if_changed ".*\.prisma" "node node_modules/.bin/dotenv -c development -- node node_modules/.bin/prisma migrate deploy"`,
      String.raw`run_if_changed ".*\.prisma" "node node_modules/.bin/dotenv -c development -- node node_modules/.bin/prisma generate"`
    );
  }
  const genI18nTsCommand = getGenI18nTsCommand(config, config.packageJson?.scripts);
  if (genI18nTsCommand) {
    // gen-i18n-ts outputs are commonly ignored, so post-merge regenerates them after pulled resource changes.
    postMergeCommands.push(String.raw`run_if_changed "(^|/)i18n/.*\.json$|(^|/)package\.json$" "${genI18nTsCommand}"`);
  }
  return postMergeCommands;
}

function hasPythonPackageManager(config: PackageConfig): boolean {
  return config.doesContainPoetryLock || config.doesContainUvLock;
}

function getPythonRunner(config: PackageConfig): 'poetry run' | 'uv run' {
  return config.doesContainUvLock ? 'uv run' : 'poetry run';
}
