import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { repoResolvesPrivatePackages } from '../../src/github/verdaccioSecret.js';
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

test('detects a bunx invocation of a private package in a manifest script', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), {
      name: 'runner',
      scripts: { 'update-deps': 'bunx @willbooster-private/agentic-workflows@1.71.3' },
    });
    expect(repoResolvesPrivatePackages(createConfig({ dirPath: tempDirPath }))).toBe(true);
  });
});

test('detects a Verdaccio publishConfig registry', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), {
      name: 'publisher',
      publishConfig: { registry: 'https://verdaccio-production-e389.up.railway.app/' },
    });
    expect(repoResolvesPrivatePackages(createConfig({ dirPath: tempDirPath }))).toBe(true);
  });
});

test('detects a private package recorded only in the lockfile', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), { name: 'transitive' });
    fs.writeFileSync(path.join(tempDirPath, 'bun.lock'), '"@willbooster-private/some-lib": ["1.0.0", "", {}]\n');
    expect(repoResolvesPrivatePackages(createConfig({ dirPath: tempDirPath }))).toBe(true);
  });
});

test('detects private-package usage in a custom workflow, but not the standard secret pass-through', async () => {
  await withTempDir(async (tempDirPath) => {
    writeJson(path.join(tempDirPath, 'package.json'), { name: 'workflows' });
    const workflowsDirPath = path.join(tempDirPath, '.github', 'workflows');
    fs.mkdirSync(workflowsDirPath, { recursive: true });
    // The generated caller mentions only the secret NAME; it must not count as usage.
    fs.writeFileSync(
      path.join(workflowsDirPath, 'test.yml'),
      'jobs:\n  test:\n    secrets:\n      VERDACCIO_TOKEN: ${{ secrets.VERDACCIO_TOKEN }}\n'
    );
    const config = createConfig({ dirPath: tempDirPath });
    expect(repoResolvesPrivatePackages(config)).toBe(false);

    fs.writeFileSync(
      path.join(workflowsDirPath, 'custom.yml'),
      'jobs:\n  run:\n    steps:\n      - run: bunx @willbooster-private/agentic-workflows\n'
    );
    expect(repoResolvesPrivatePackages(config)).toBe(true);
  });
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, undefined, 2));
}

async function withTempDir(testBody: (tempDirPath: string) => Promise<void>): Promise<void> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-verdaccio-secret-')));
  try {
    await testBody(tempDirPath);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}
