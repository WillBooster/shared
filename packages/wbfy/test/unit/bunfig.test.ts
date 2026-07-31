import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  extractRawTestSections,
  generateBunfigToml,
  readBunGlobalStore,
  shouldUseBunGlobalStore,
} from '../../src/generators/bunfig.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

test('preserves [test] sections with their comments and drops other sections', () => {
  const existingContent = `env = false
telemetry = false

[run]
bun = true

[test]
# The production db client targets Cloudflare D1; unit tests swap it for a
# local SQLite client before any test module loads.
preload = ["./test/unit/preloadDbClient.ts"]

[install]
exact = true
`;

  expect(extractRawTestSections(existingContent)).toBe(`[test]
# The production db client targets Cloudflare D1; unit tests swap it for a
# local SQLite client before any test module loads.
preload = ["./test/unit/preloadDbClient.ts"]

`);
});

test('returns an empty string when there is no [test] section', () => {
  expect(extractRawTestSections(undefined)).toBe('');
  expect(extractRawTestSections('env = false\n\n[install]\nexact = true\n')).toBe('');
});

test('keeps Next.js and Blitz dependencies inside the project', () => {
  expect(shouldUseBunGlobalStore([createConfig()])).toBe(true);
  expect(
    shouldUseBunGlobalStore([createConfig(), createConfig({ depending: { ...createConfig().depending, next: true } })])
  ).toBe(false);
  expect(
    shouldUseBunGlobalStore([createConfig(), createConfig({ depending: { ...createConfig().depending, blitz: true } })])
  ).toBe(false);
});

test('keeps Next.js dependencies inside the Turbopack filesystem root', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-next-bunfig-')));
  try {
    // The root package need not depend on Next.js when a workspace app does; the repository-wide
    // decision is passed separately from the root PackageConfig.
    const config = createConfig({ dirPath: tempDirPath });
    await generateBunfigToml(config, false);
    await promisePool.promiseAll();

    const content = fs.readFileSync(path.join(tempDirPath, 'bunfig.toml'), 'utf8');
    expect(content).toContain('# Keep Turbopack dependencies inside the project root.\nglobalStore = false');
    expect(content).toContain('linker = "isolated"');
    expect(readBunGlobalStore(tempDirPath)).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('keeps a configured minimumReleaseAge across regenerations', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-bunfig-')));
  try {
    fs.writeFileSync(path.join(tempDirPath, 'bunfig.toml'), '[install]\nminimumReleaseAge = 172800\n');
    await generateBunfigToml(createConfig({ dirPath: tempDirPath }), true);
    await promisePool.promiseAll();
    const content = fs.readFileSync(path.join(tempDirPath, 'bunfig.toml'), 'utf8');
    expect(content).toContain('minimumReleaseAge = 172800');

    await generateBunfigToml(createConfig({ dirPath: tempDirPath }), true);
    await promisePool.promiseAll();
    const regenerated = fs.readFileSync(path.join(tempDirPath, 'bunfig.toml'), 'utf8');
    expect(regenerated).toContain('minimumReleaseAge = 172800');
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('removes repository-specific minimumReleaseAgeExcludes entries — the list is org policy', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfig-excludes-')));
  try {
    // Entries outside bunMinimumReleaseAgeExcludes must disappear so every repository shares the
    // same vetted list.
    fs.writeFileSync(
      path.join(tempDirPath, 'bunfig.toml'),
      `[install]
minimumReleaseAge = 432000 # 5 days
minimumReleaseAgeExcludes = [
    "@next/eslint-plugin-next",
    "react",
    # ---------- repository-specific entries ----------
    "my-repo-specific-package",
]
`
    );
    await generateBunfigToml(createConfig({ dirPath: tempDirPath }), true);
    await promisePool.promiseAll();
    const content = fs.readFileSync(path.join(tempDirPath, 'bunfig.toml'), 'utf8');
    expect(content).not.toContain('@next/eslint-plugin-next');
    expect(content).not.toContain('my-repo-specific-package');
    expect(content).not.toContain('---------- repository-specific entries');
    // Managed entries stay, each exactly once.
    expect(content.match(/^\s+"react",$/gmu)).toHaveLength(1);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});
