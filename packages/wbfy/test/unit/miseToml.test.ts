import fs from 'node:fs';
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
  fs.mkdirSync('.tmp', { recursive: true });
  const dirPath = fs.mkdtempSync(path.resolve('.tmp', 'wbfy-mise-'));
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

test('pins the concrete version behind an lts/* mise selector and adds a concrete Bun pin', async () => {
  const content = await generateFrom({ 'mise.toml': '[tools]\nnode = "lts/*"\n' });

  expect(content).not.toContain('lts/*');
  expect(content).toMatch(/node = "\d+\.\d+\.\d+"/u);
  expect(content).toMatch(/bun = "\d+\.\d+\.\d+"/u);
});

test('updates Bun and fnox to the latest releases while preserving unrelated settings', async () => {
  const latestBun = Bun.spawnSync(['mise', 'latest', 'bun']).stdout.toString().trim();
  const latestFnox = Bun.spawnSync(['mise', 'latest', 'fnox']).stdout.toString().trim();
  const content = await generateFrom({
    'mise.toml':
      '[tools]\nnode = "22.0.0"\nbun = "0.1.0"\nfnox = "0.1.0"\npython = "3.12.0"\n[settings]\nexperimental = true\n',
    'fnox.toml': '',
  });

  expect(Bun.TOML.parse(content)).toEqual({
    tools: { node: '22.0.0', bun: latestBun, fnox: latestFnox, python: '3.12.0' },
    settings: { experimental: true },
  });
});
