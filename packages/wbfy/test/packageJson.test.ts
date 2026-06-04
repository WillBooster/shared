import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import { createConfig } from './testConfig.js';

test('replaces gen-i18n-ts postinstall with wb gen-code', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');
  await fs.mkdir(path.join(dirPath, 'i18n'));

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
    expect(packageJson.scripts.cleanup).toBe('yarn gen-i18n-ts && yarn format');
    expect(packageJson.scripts['gen-code']).toBe('wb gen-code');
    expect(packageJson.scripts['gen-i18n-ts']).toBe('gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP');
    expect(packageJson.scripts.postinstall).toBe('wb gen-code');
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('restores missing default gen-i18n-ts script with wb gen-code postinstall', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');
  await fs.mkdir(path.join(dirPath, 'i18n'));

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify({
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
      scripts: {},
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
    expect(packageJson.scripts.cleanup).toBe('yarn gen-i18n-ts && yarn format');
    expect(packageJson.scripts['gen-code']).toBe('wb gen-code');
    expect(packageJson.scripts['gen-i18n-ts']).toBe('gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP');
    expect(packageJson.scripts.postinstall).toBe('wb gen-code');
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('keeps custom gen-i18n-ts scripts', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');
  await fs.mkdir(path.join(dirPath, 'i18n'));

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify({
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
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
    expect(packageJson.scripts['gen-code']).toBe('wb gen-code');
    expect(packageJson.scripts['gen-i18n-ts']).toBe('gen-i18n-ts -i locales -o src/i18n.ts -d en-US');
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('replaces unrelated postinstall commands when code generation is managed', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');
  await fs.mkdir(path.join(dirPath, 'i18n'));

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify({
      scripts: {
        postinstall: 'echo before && yarn run gen-i18n-ts > /dev/null && echo after',
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    })
  );

  try {
    const config = createConfig({
      dirPath,
      isRoot: false,
      depending: { ...createConfig().depending, genI18nTs: true },
    });
    await generatePackageJson(config, config, true);

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };
    expect(packageJson.scripts.postinstall).toBe('wb gen-code');
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('replaces empty postinstall command variants when code generation is managed', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  const packageJsonPath = path.join(dirPath, 'package.json');
  await fs.mkdir(path.join(dirPath, 'i18n'));

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify({
      scripts: {
        postinstall: ' && yarn gen-i18n-ts && bun   run   gen-i18n-ts>/dev/null && ',
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    })
  );

  try {
    const config = createConfig({
      dirPath,
      isRoot: false,
      depending: { ...createConfig().depending, genI18nTs: true },
    });
    await generatePackageJson(config, config, true);

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };
    expect(packageJson.scripts.postinstall).toBe('wb gen-code');
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
    expect(packageJson.dependencies['build-ts']).toBe('17.1.18');
    expect(packageJson.devDependencies['build-ts']).toBeUndefined();
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});
