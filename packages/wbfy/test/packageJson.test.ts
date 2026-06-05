import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import { createConfig } from './testConfig.js';

interface GeneratedPackageJson {
  dependencies?: Record<string, string | undefined>;
  devDependencies?: Record<string, string | undefined>;
  scripts?: Record<string, string | undefined>;
}

const genI18nTsDepending = {
  ...createConfig().depending,
  genI18nTs: true,
};

test('replaces default gen-i18n-ts postinstall with managed wb gen-code scripts', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP',
        postinstall: 'yarn run gen-i18n-ts > /dev/null',
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    },
    { depending: genI18nTsDepending, isRoot: true },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    cleanup: 'yarn format',
    'gen-code': 'wb gen-code',
    postinstall: 'wb gen-code',
  });
  expect(packageJson.scripts?.['gen-i18n-ts']).toBeUndefined();
});

test('does not restore missing default gen-i18n-ts script with managed wb gen-code postinstall', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
      scripts: {},
    },
    { depending: genI18nTsDepending, isRoot: true },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    cleanup: 'yarn format',
    'gen-code': 'wb gen-code',
    postinstall: 'wb gen-code',
  });
  expect(packageJson.scripts?.['gen-i18n-ts']).toBeUndefined();
});

test('keeps custom gen-i18n-ts scripts while adding wb gen-code', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    },
    { depending: genI18nTsDepending, isRoot: true },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    'gen-code': 'wb gen-code',
    'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
  });
});

test.each([
  ['mixed commands around gen-i18n-ts', 'echo before && yarn run gen-i18n-ts > /dev/null && echo after'],
  ['empty command segments around gen-i18n-ts', ' && yarn gen-i18n-ts && bun   run   gen-i18n-ts>/dev/null && '],
])('replaces %s with managed wb gen-code postinstall', async (_description, postinstall) => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        postinstall,
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
});

test('keeps build-ts as a runtime dependency when prisma seed uses it', async () => {
  const packageJson = await generatePackageJsonFrom({
    devDependencies: {
      'build-ts': '17.1.18',
    },
    dependencies: {
      'build-ts': '17.1.15',
    },
    prisma: {
      seed: 'build-ts run prisma/seed.ts',
    },
    scripts: {},
  });

  expect(packageJson.dependencies?.['build-ts']).toBe('17.1.18');
  expect(packageJson.devDependencies?.['build-ts']).toBeUndefined();
});

test('keeps wb as a runtime dependency when postinstall uses it', async () => {
  const packageJson = await generatePackageJsonFrom({
    devDependencies: {
      '@willbooster/wb': '13.22.7',
    },
    scripts: {
      'gen-code': 'wb gen-code',
      postinstall: 'wb gen-code',
    },
  });

  expect(packageJson.dependencies?.['@willbooster/wb']).toBe('13.22.7');
  expect(packageJson.devDependencies?.['@willbooster/wb']).toBeUndefined();
});

async function generatePackageJsonFrom(
  initialPackageJson: Record<string, unknown>,
  configOverrides: Parameters<typeof createConfig>[0] = {},
  options: { createI18nDir?: boolean } = {}
): Promise<GeneratedPackageJson> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');

  try {
    if (options.createI18nDir) {
      await fs.mkdir(path.join(dirPath, 'i18n'));
    }
    await fs.writeFile(packageJsonPath, JSON.stringify(initialPackageJson));

    const config = createConfig({
      ...configOverrides,
      dirPath,
    });
    await generatePackageJson(config, config, true);

    return JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as GeneratedPackageJson;
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
}
