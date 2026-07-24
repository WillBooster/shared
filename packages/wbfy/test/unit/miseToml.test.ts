import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { generateMiseToml } from '../../src/generators/miseToml.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// setRootDirPath is process-wide state: leaving a deleted temporary directory behind would confine
// any later test sharing this worker to a repository root that no longer exists.
afterEach(() => {
  fsUtil.setRootDirPath(undefined);
});

async function generateFrom(migrationSources: Record<string, string>): Promise<string> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-mise-'));
  try {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    for (const [fileName, content] of Object.entries(migrationSources)) {
      fs.writeFileSync(path.join(dirPath, fileName), content);
    }
    fsUtil.setRootDirPath(dirPath);
    await generateMiseToml(createConfig({ dirPath }), '1.3.14');
    await promisePool.promiseAll();
    return fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8');
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
}

// The .tool-versions migration writes an array when an entry lists several versions, so those
// arrays are wbfy's own output and must still meet the Bun floor: an older Bun silently ignores
// the options in the generated bunfig.toml.
test('lifts every Bun version migrated from a multi-version .tool-versions entry', async () => {
  const content = await generateFrom({ '.tool-versions': 'bun 1.2.0 1.3.14\nnodejs 24.18.0\n' });

  expect(content).not.toContain('1.2.0');
  expect(content).toContain('bun = [ "1.3.14" ]');
});

// `lts/*` is the idiomatic .node-version spelling, but `mise latest node@lts/*` exits 0 with empty
// output (mise 2026.7.7), so it must be normalized before resolution or the pin stays unresolved.
test('pins the concrete version behind an lts/* .node-version selector', async () => {
  const content = await generateFrom({ '.node-version': 'lts/*\n' });

  expect(content).not.toContain('lts/*');
  expect(content).toMatch(/node = "\d+\.\d+\.\d+"/u);
});
