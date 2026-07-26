import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { repoResolvesPrivatePackages } from '../../src/utils/privatePackages.js';
import { createConfig } from '../helpers/testConfig.js';

test('detects no private-package usage in a plain repository', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), { name: 'plain', dependencies: { react: '19.0.0' } });
    expect(repoResolvesPrivatePackages(createConfig({ dirPath: tempDirPath }))).toBe(false);
  });
});

test('a bunfig.toml minimumReleaseAgeExcludes entry alone is not a dependency', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), { name: 'plain' });
    fs.writeFileSync(
      path.join(tempDirPath, 'bunfig.toml'),
      '[install]\nminimumReleaseAgeExcludes = ["@willbooster-private/agentic-workflows"]\n'
    );
    expect(repoResolvesPrivatePackages(createConfig({ dirPath: tempDirPath }))).toBe(false);
  });
});

test('detects a private dependency in the root manifest', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), {
      name: 'consumer',
      devDependencies: { '@willbooster-private/agentic-workflows': '1.0.0' },
    });
    expect(repoResolvesPrivatePackages(createConfig({ dirPath: tempDirPath }))).toBe(true);
  });
});

test('detects a private dependency in a workspace manifest', async () => {
  await withTempDir(async (tempDirPath) => {
    const rootManifest = { name: 'root', workspaces: ['packages/*'] };
    writeJson(path.join(tempDirPath, 'package.json'), rootManifest);
    writeJson(path.join(tempDirPath, 'packages', 'app', 'package.json'), {
      name: 'app',
      dependencies: { '@willbooster-private/some-lib': '1.0.0' },
    });
    const config = createConfig({
      dirPath: tempDirPath,
      doesContainSubPackageJsons: true,
      packageJson: rootManifest,
    });
    expect(repoResolvesPrivatePackages(config)).toBe(true);
  });
});

test('detects a package published to Verdaccio via its scoped name', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), { name: '@willbooster-private/agentic-workflows' });
    expect(repoResolvesPrivatePackages(createConfig({ dirPath: tempDirPath }))).toBe(true);
  });
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, undefined, 2));
}

async function withTempDir(testBody: (tempDirPath: string) => Promise<void>): Promise<void> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-private-packages-')));
  try {
    await testBody(tempDirPath);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}
