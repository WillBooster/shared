import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'bun:test';
import semver from 'semver';

import { generateMiseToml, minimumBunVersion } from '../../src/generators/miseToml.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// setRootDirPath is process-wide state: leaving a deleted temporary directory behind would confine
// any later test sharing this worker to a repository root that no longer exists.
afterEach(() => {
  fsUtil.setRootDirPath(undefined);
});

async function generateFrom(files: Record<string, string>, currentBunVersion = Bun.version): Promise<string> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-mise-'));
  try {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    for (const [fileName, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dirPath, fileName), content);
    }
    fsUtil.setRootDirPath(dirPath);
    await generateMiseToml(createConfig({ dirPath }), currentBunVersion);
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

test('uses the running Bun version when the pin is missing', async () => {
  const content = await generateFrom({ 'mise.toml': '[tools]\nnode = "24.19.0"\n' }, '1.9.9');

  expect(content).toContain('bun = "1.9.9"');
});

test('replaces a Bun pin below the supported runtime floor', async () => {
  const outdatedBunVersion = '1.3.14';
  expect(semver.lt(outdatedBunVersion, minimumBunVersion)).toBe(true);
  const content = await generateFrom({ 'mise.toml': `[tools]\nbun = "${outdatedBunVersion}"\n` }, minimumBunVersion);

  expect(content).toContain(`bun = "${minimumBunVersion}"`);
});

test('leaves a non-string Bun pin untouched', async () => {
  const miseToml = '[tools]\nnode = "24.19.0"\nbun = { version = "1.5.9" }\n';
  const content = await generateFrom({ 'mise.toml': miseToml }, minimumBunVersion);

  expect(content).toBe(miseToml);
});

test('leaves an unresolvable Bun selector untouched', async () => {
  const miseToml = '[tools]\nnode = "24.19.0"\nbun = "sub-2:lts"\n';
  const content = await generateFrom({ 'mise.toml': miseToml }, minimumBunVersion);

  expect(content).toBe(miseToml);
});
