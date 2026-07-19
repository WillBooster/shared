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
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});
