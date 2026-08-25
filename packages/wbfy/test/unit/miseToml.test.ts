import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { generateMiseToml } from '../../src/generators/miseToml.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// setRootDirPath is process-wide state: leaving a deleted temporary directory behind would confine
// any later test sharing this worker to a repository root that no longer exists.
afterEach(() => {
  fsUtil.setRootDirPath(undefined);
});

async function generateFrom(files: Record<string, string>): Promise<string> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-mise-'));
  try {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    for (const [fileName, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dirPath, fileName), content);
    }
    fsUtil.setRootDirPath(dirPath);
    await generateMiseToml(createConfig({ dirPath }));
    await promisePool.promiseAll();
    return fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8');
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
}

test('pins the concrete version behind an lts/* mise selector', async () => {
  const content = await generateFrom({ 'mise.toml': '[tools]\nnode = "lts/*"\n' });

  expect(content).not.toContain('lts/*');
  expect(content).toMatch(/node = "\d+\.\d+\.\d+"/u);
});

test('does not add a Bun pin to a repository without one', async () => {
  const content = await generateFrom({ 'mise.toml': '[tools]\nnode = "24.19.0"\n' });

  expect(content).not.toContain('bun');
});
