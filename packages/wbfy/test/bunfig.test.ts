import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { extractRawTestSections, generateBunfigToml } from '../src/generators/bunfig.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

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

test('keeps the migrated .yarnrc.yml release-age-gate behavior in the generated bunfig.toml', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-bunfig-')));
  try {
    await generateBunfigToml(createConfig({ dirPath: tempDirPath }), 'isolated', {
      minimumReleaseAgeSeconds: 172_800,
      minimumReleaseAgeExcludes: ['my-repo-specific-package', 'react'],
    });
    await promisePool.promiseAll();
    const content = fs.readFileSync(path.join(tempDirPath, 'bunfig.toml'), 'utf8');
    expect(content).toContain('minimumReleaseAge = 172800');
    expect(content).toContain('"my-repo-specific-package",');
    // Entries already in the managed list must not be duplicated.
    expect(content.match(/^\s+"react",$/gmu)).toHaveLength(1);

    // A later run has no .yarnrc.yml to read anymore (removeYarnFiles deleted it), so the
    // repo-specific policy must survive via the existing bunfig.toml.
    await generateBunfigToml(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    const regenerated = fs.readFileSync(path.join(tempDirPath, 'bunfig.toml'), 'utf8');
    expect(regenerated).toContain('minimumReleaseAge = 172800');
    expect(regenerated).toContain('"my-repo-specific-package",');
    expect(regenerated.match(/^\s+"react",$/gmu)).toHaveLength(1);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('drops managed exclude entries retired from the managed list instead of keeping them as repo policy', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfig-retired-')));
  try {
    // An entry an older wbfy version managed (e.g. @next/eslint-plugin-next) sits ABOVE the
    // repository-specific marker, so a regeneration must not preserve it.
    fs.writeFileSync(
      path.join(tempDirPath, 'bunfig.toml'),
      `[install]
minimumReleaseAge = 432000 # 5 days
minimumReleaseAgeExcludes = [
    "@next/eslint-plugin-next",
    "react",
    # ---------- repository-specific entries ----------
    "my-repo-specific-package",

    # a hand-added comment must not truncate the repository-policy list
    'single-quoted-package', # inline comment
    'not@a@name',
]
`
    );
    await generateBunfigToml(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    const content = fs.readFileSync(path.join(tempDirPath, 'bunfig.toml'), 'utf8');
    expect(content).not.toContain('@next/eslint-plugin-next');
    expect(content).toContain('"my-repo-specific-package",');
    expect(content).toContain('"single-quoted-package",');
    // A marker entry that is not a plain npm package name is dead configuration and is dropped.
    expect(content).not.toContain('not@a@name');
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});
