import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { findUnmigratableYarnSettings, readYarnrcReleaseAgeSettings } from '../src/generators/removeYarnFiles.js';

// The .yarnrc.yml shape the org standard (yarn-plugin-auto-install era) rolls out to apps.
const orgStandardYarnrc = `approvedGitRepositories:
  - 'https://github.com/WillBooster/*.git'
  - 'ssh://git@github.com/WillBooster/*.git'

defaultSemverRangePrefix: ''

enableGlobalCache: true

enableScripts: false

nodeLinker: node-modules

npmMinimalAgeGate: 5d

npmPreapprovedPackages:
  - '@willbooster/*'
  - one-way-git-sync
  - my-repo-specific-package

yarnPath: .yarn/releases/yarn-4.17.1.cjs
`;

test('treats the org-standard release-age-gate settings as migratable', async () => {
  await withTempDir(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, '.yarnrc.yml'), orgStandardYarnrc);
    expect(findUnmigratableYarnSettings(tempDirPath)).toBeUndefined();
  });
});

test('still blocks on enableScripts: true, which Bun cannot honor wholesale', async () => {
  await withTempDir(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, '.yarnrc.yml'), 'enableScripts: true\n');
    expect(findUnmigratableYarnSettings(tempDirPath)).toBe(
      '.yarnrc.yml declares behavior-affecting settings [enableScripts]'
    );
  });
});

test('reports every blocker at once instead of only the first one', async () => {
  await withTempDir(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, '.yarnrc.yml'), 'npmRegistryServer: https://example.com\n');
    fs.mkdirSync(path.join(tempDirPath, '.yarn', 'patches'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDirPath, 'package.json'),
      JSON.stringify({ resolutions: { next: 'patch:next@npm%3A16.0.0#~/.yarn/patches/next.patch' } })
    );
    expect(findUnmigratableYarnSettings(tempDirPath)).toBe(
      '.yarnrc.yml declares behavior-affecting settings [npmRegistryServer]; ' +
        '.yarn/patches exists; package.json uses the patch: protocol'
    );
  });
});

test('reads release-age settings, dropping glob patterns Bun would match literally', async () => {
  await withTempDir(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, '.yarnrc.yml'), orgStandardYarnrc);
    expect(readYarnrcReleaseAgeSettings(tempDirPath)).toEqual({
      minimumReleaseAgeSeconds: 432_000,
      minimumReleaseAgeExcludes: ['one-way-git-sync', 'my-repo-specific-package'],
    });
  });
});

test('parses Yarn duration variants (bare numbers mean minutes)', async () => {
  await withTempDir(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, '.yarnrc.yml'), 'npmMinimalAgeGate: 36h\n');
    expect(readYarnrcReleaseAgeSettings(tempDirPath).minimumReleaseAgeSeconds).toBe(129_600);

    fs.writeFileSync(path.join(tempDirPath, '.yarnrc.yml'), 'npmMinimalAgeGate: 30\n');
    expect(readYarnrcReleaseAgeSettings(tempDirPath).minimumReleaseAgeSeconds).toBe(1800);
  });
});

test('returns empty settings without a .yarnrc.yml', async () => {
  await withTempDir(async (tempDirPath) => {
    expect(readYarnrcReleaseAgeSettings(tempDirPath)).toEqual({ minimumReleaseAgeExcludes: [] });
  });
});

async function withTempDir(testBody: (tempDirPath: string) => Promise<void>): Promise<void> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-remove-yarn-files-')));
  try {
    await testBody(tempDirPath);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
}
