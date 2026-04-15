import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { doesContainJsOrTs } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSync } from '../utils/spawnUtil.js';

import { generateScripts } from './packageJson.js';

interface LefthookSettings {
  'post-merge': {
    scripts: {
      'prepare.sh': {
        runner: 'bash';
      };
    };
  };
  'pre-commit': {
    commands: {
      cleanup: {
        glob: string;
        run: string;
      };
      'check-migrations': {
        glob: string;
        run: string;
      };
    };
  };
  'pre-push': {
    scripts: {
      'check.sh': {
        runner: 'bash';
      };
    };
  };
}

const baseSettings: Omit<LefthookSettings, 'pre-commit'> = {
  'post-merge': {
    scripts: {
      'prepare.sh': {
        runner: 'bash',
      },
    },
  },
  'pre-push': {
    scripts: {
      'check.sh': {
        runner: 'bash',
      },
    },
  },
};

const preCommitSettings: LefthookSettings['pre-commit'] = {
  commands: {
    cleanup: {
      glob: '',
      run: '',
    },
    'check-migrations': {
      glob: '**/migration.sql',
      run: `
if grep -q 'Warnings:' {staged_files}; then
  echo "Migration SQL files ({staged_files}) contain warnings! Please solve the warnings and commit again."
  exit 1
fi
`.trim(),
    },
  },
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
      ...preCommitSettings,
      commands: {
        ...preCommitSettings.commands,
        cleanup: {
          ...preCommitSettings.commands.cleanup,
          glob: getCleanupGlobs(config),
          run: getCleanupCommand(config),
        },
      },
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
    await promisePool.run(() =>
      fs.promises.writeFile(path.join(dirPath, 'pre-push', 'check.sh'), prePush + '\n', {
        mode: 0o755,
      })
    );
  }
  const postMergeCommand = `${scripts.postMerge}\n\n${generatePostMergeCommands(config).join('\n')}\n`;
  fs.mkdirSync(path.join(dirPath, 'post-merge'), { recursive: true });
  await promisePool.run(() =>
    fs.promises.writeFile(path.resolve(dirPath, 'post-merge', 'prepare.sh'), postMergeCommand, {
      mode: 0o755,
    })
  );
}

function getPrePushScript(config: PackageConfig): string {
  let lintCommand: string;
  if (config.isBun) {
    lintCommand = config.depending.wb ? 'bun --bun wb lint' : 'bun run lint';
  } else {
    lintCommand = config.depending.wb ? 'yarn wb lint' : 'yarn run lint';
  }
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

function getCleanupGlobs(config: PackageConfig): string {
  const supportedExtensions = [...extensions.prettierOnly];
  if (doesContainJsOrTs(config)) {
    supportedExtensions.push(...extensions.oxfmt, ...extensions.oxlint);
  }
  if (config.doesContainPoetryLock) {
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
    return 'yarn workspace @willbooster/wb start --working-dir "$(git rev-parse --show-toplevel)" lint --fix --format -- {staged_files} && git add -- {staged_files}';
  }
  if (config.isBun || config.depending.wb) {
    const packageManager = config.isBun ? 'bun' : 'yarn';
    const command = config.depending.wb
      ? `${config.isBun ? 'bun --bun wb' : 'yarn wb'} lint --fix --format -- {staged_files}`
      : `${packageManager} run format && ${packageManager} run lint-fix`;
    return `${command} && git add -- {staged_files}`;
  }

  const oxlintPattern = extensions.oxlint.map((extension) => String.raw`\.${extension}$`).join('|');
  const oxfmtPattern = extensions.oxfmt.map((extension) => String.raw`\.${extension}$`).join('|');
  const prettierPattern = extensions.prettierOnly.map((extension) => String.raw`\.${extension}$`).join('|');
  const hasJsOrTs = doesContainJsOrTs(config);

  return String.raw`
${hasJsOrTs ? String.raw`oxlint_files="$(printf '%s\n' {staged_files} | grep -E '(${oxlintPattern})' || true)"` : ''}
${hasJsOrTs ? String.raw`oxfmt_files="$(printf '%s\n' {staged_files} | grep -E '(${oxfmtPattern})' || true)"` : ''}
prettier_files="$(printf '%s\n' {staged_files} | grep -E '(${prettierPattern})' || true)"
package_json_files="$(printf '%s\n' {staged_files} | grep -E '(^|/)package\.json$' || true)"
${config.doesContainPoetryLock ? String.raw`python_files="$(printf '%s\n' {staged_files} | grep -E '\.py$' || true)"` : ''}
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
if [ -n "$prettier_files" ]; then
  node node_modules/.bin/prettier --cache --write --ignore-unknown -- $prettier_files
fi
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
  config.doesContainPoetryLock
    ? `if [ -n "$python_files" ]; then
  poetry run isort --profile black --filter-files $python_files
  poetry run black $python_files
  poetry run flake8 $python_files
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
git add -- {staged_files}
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
  return postMergeCommands;
}
