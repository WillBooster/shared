import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { generateLefthookUpdatingPackageJson } from '../src/generators/lefthook.js';
import type { PackageConfig } from '../src/packageConfig.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })));
  tempDirs.length = 0;
});

test('includes python files in cleanup glob when poetry is used', async () => {
  const dirPath = createTempDir();

  await generateLefthookUpdatingPackageJson(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainPoetryLock: true,
      doesContainUvLock: false,
      doesContainTypeScript: true,
    })
  );

  const lefthookConfig = await fs.promises.readFile(path.join(dirPath, 'lefthook.yml'), 'utf8');
  expect(lefthookConfig).toContain("glob: '**/*.{");
  expect(lefthookConfig).toContain('py');
  expect(lefthookConfig).toContain('python_files=');
  expect(lefthookConfig).toContain('poetry run isort');
  expect(lefthookConfig).not.toContain('lint-staged');
});

test('uses uv for python cleanup and install hooks when uv is used', async () => {
  const dirPath = createTempDir();

  await generateLefthookUpdatingPackageJson(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainTypeScript: true,
      doesContainUvLock: true,
    })
  );

  const lefthookConfig = await fs.promises.readFile(path.join(dirPath, 'lefthook.yml'), 'utf8');
  const postMergeScript = await fs.promises.readFile(
    path.join(dirPath, '.lefthook', 'post-merge', 'prepare.sh'),
    'utf8'
  );
  expect(lefthookConfig).toContain('py');
  expect(lefthookConfig).toContain('python_files=');
  expect(lefthookConfig).toContain('uv run isort');
  expect(lefthookConfig).not.toContain('poetry run');
  expect(postMergeScript).toContain(String.raw`run_if_changed "uv\.lock" "uv sync --frozen"`);
});

test('includes dart files in cleanup glob when pubspec is present', async () => {
  const dirPath = createTempDir();

  await generateLefthookUpdatingPackageJson(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainPubspecYaml: true,
    })
  );

  const lefthookConfig = await fs.promises.readFile(path.join(dirPath, 'lefthook.yml'), 'utf8');
  expect(lefthookConfig).toContain("glob: '**/*.{");
  expect(lefthookConfig).toContain('dart');
  expect(lefthookConfig).toContain('dart_files=');
  expect(lefthookConfig).not.toContain('lint-staged');
});

test('uses local wb workspace for cleanup when available', async () => {
  const dirPath = createTempDir();
  await fs.promises.mkdir(path.join(dirPath, 'packages', 'wb'), { recursive: true });
  await fs.promises.writeFile(
    path.join(dirPath, 'packages', 'wb', 'package.json'),
    JSON.stringify({ name: '@willbooster/wb' })
  );

  await generateLefthookUpdatingPackageJson(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainSubPackageJsons: true,
      doesContainTypeScriptInPackages: true,
      packageJson: {
        private: true,
        workspaces: ['packages/*'],
      },
    })
  );

  const lefthookConfig = await fs.promises.readFile(path.join(dirPath, 'lefthook.yml'), 'utf8');
  expect(lefthookConfig).toContain(
    'yarn workspace @willbooster/wb start --working-dir "$(git rev-parse --show-toplevel)" lint --fix --format -- {staged_files}'
  );
  expect(lefthookConfig).not.toContain('printf');
});

test('does not generate oxlint or oxfmt hooks for package-only projects', async () => {
  const dirPath = createTempDir();

  await generateLefthookUpdatingPackageJson(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
    })
  );

  const lefthookConfig = await fs.promises.readFile(path.join(dirPath, 'lefthook.yml'), 'utf8');
  expect(lefthookConfig).not.toContain('pre-push');
  expect(lefthookConfig).not.toContain('oxfmt');
  expect(lefthookConfig).not.toContain('oxlint');
});

test('runs gen-i18n-ts from lefthook when i18n resources change', async () => {
  const dirPath = createTempDir();

  await generateLefthookUpdatingPackageJson(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainTypeScript: true,
      depending: {
        ...createConfig().depending,
        genI18nTs: true,
      },
      packageJson: {
        scripts: {
          'gen-i18n-ts': 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP',
        },
      },
    })
  );

  const lefthookConfig = await fs.promises.readFile(path.join(dirPath, 'lefthook.yml'), 'utf8');
  const postMergeScript = await fs.promises.readFile(
    path.join(dirPath, '.lefthook', 'post-merge', 'prepare.sh'),
    'utf8'
  );
  expect(lefthookConfig).toContain('name: gen-i18n-ts');
  expect(lefthookConfig).toContain('glob: i18n/*.json');
  expect(lefthookConfig).toContain('yarn gen-i18n-ts > /dev/null');
  expect(postMergeScript).toContain(
    String.raw`run_if_changed "(^|/)i18n/.*\.json$|(^|/)package\.json$" "yarn gen-i18n-ts > /dev/null"`
  );
});

function createTempDir(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-lefthook-'));
  tempDirs.push(dirPath);
  return dirPath;
}

function createConfig(overrides: Partial<PackageConfig> = {}): PackageConfig {
  return {
    dirPath: '/tmp',
    dockerfile: '',
    isRoot: true,
    isPublicRepo: true,
    isReferredByOtherRepo: false,
    repository: 'github:WillBooster/example',
    isWillBoosterRepo: true,
    isBun: false,
    isEsmPackage: false,
    isWillBoosterConfigs: false,
    doesContainSubPackageJsons: false,
    doesContainDockerfile: false,
    doesContainGemfile: false,
    doesContainGoMod: false,
    doesContainPackageJson: false,
    doesContainPoetryLock: false,
    doesContainUvLock: false,
    doesContainPomXml: false,
    doesContainPubspecYaml: false,
    doesContainTemplateYaml: false,
    doesContainVscodeSettingsJson: false,
    doesContainJavaScript: false,
    doesContainTypeScript: false,
    doesContainJsxOrTsx: false,
    doesContainJava: false,
    doesContainJavaScriptInPackages: false,
    doesContainTypeScriptInPackages: false,
    doesContainJsxOrTsxInPackages: false,
    doesContainJavaInPackages: false,
    hasStartTestServer: false,
    depending: {
      blitz: false,
      firebase: false,
      genI18nTs: false,
      litestream: false,
      next: false,
      playwrightTest: false,
      prisma: false,
      pyright: false,
      react: false,
      reactNative: false,
      semanticRelease: false,
      storybook: false,
      wb: false,
    },
    release: {
      branches: [],
      github: false,
      npm: false,
    },
    hasVersionSettings: false,
    packageJson: {},
    ...overrides,
  };
}
