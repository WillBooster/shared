import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import { createConfig } from './testConfig.js';

test('moves gen-i18n-ts execution from postinstall to gen-code', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify({
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP',
        postinstall: 'yarn run gen-i18n-ts > /dev/null',
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    })
  );

  try {
    const config = createConfig({
      dirPath,
      isRoot: true,
      depending: { ...createConfig().depending, genI18nTs: true },
    });
    await generatePackageJson(config, config, true);

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };
    expect(packageJson.scripts['gen-code']).toBe('wb gen-code && yarn run gen-i18n-ts');
    expect(packageJson.scripts.postinstall).toBeUndefined();
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('keeps build-ts as a runtime dependency when prisma seed uses it', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify({
      dependencies: {
        'build-ts': '17.0.0',
      },
      prisma: {
        seed: 'build-ts run prisma/seed.ts',
      },
      scripts: {},
    })
  );

  try {
    const config = createConfig({
      dirPath,
      isRoot: true,
    });
    await generatePackageJson(config, config, true);

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string | undefined>;
      devDependencies: Record<string, string | undefined>;
    };
    expect(packageJson.dependencies['build-ts']).toBeDefined();
    expect(packageJson.devDependencies['build-ts']).toBeUndefined();
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});
