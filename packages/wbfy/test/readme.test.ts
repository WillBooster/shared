import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateReadme } from '../src/generators/readme.js';
import { promisePool } from '../src/utils/promisePool.js';
import { fsUtil } from '../src/utils/fsUtil.js';
import { createConfig } from './testConfig.js';

const wbfyBadgeLine =
  '[![wbfy](https://img.shields.io/badge/-wbfy-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)';

async function runGenerateReadme(dirPath: string): Promise<string> {
  fsUtil.setRootDirPath(dirPath);
  await generateReadme(createConfig({ dirPath, isRoot: true, packageJson: { name: 'example' } }));
  await promisePool.promiseAll();
  return fs.readFileSync(path.resolve(dirPath, 'README.md'), 'utf8');
}

test('inserts the wbfy badge and stays idempotent', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-readme-'));
  fs.writeFileSync(path.resolve(dirPath, 'README.md'), '# example\n\nA description.\n');

  const firstContent = await runGenerateReadme(dirPath);
  expect(firstContent).toContain(wbfyBadgeLine);
  expect(await runGenerateReadme(dirPath)).toBe(firstContent);
  expect(firstContent.split(wbfyBadgeLine)).toHaveLength(2);
});

test('replaces a stale wbfy badge link and creates a missing README', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-readme-'));
  expect(await runGenerateReadme(dirPath)).toBe(`# example\n\n${wbfyBadgeLine}\n`);

  fs.writeFileSync(
    path.resolve(dirPath, 'README.md'),
    '# example\n\n[![wbfy](https://img.shields.io/badge/-wbfy-1e90ff.svg)](https://example.com/old)\n'
  );
  const content = await runGenerateReadme(dirPath);
  expect(content).toContain(wbfyBadgeLine);
  expect(content).not.toContain('https://example.com/old');
});
