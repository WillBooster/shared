import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { generateReadme, readWbfyBadgeLabel } from '../src/generators/readme.js';
import { fsUtil } from '../src/utils/fsUtil.js';
import { promisePool } from '../src/utils/promisePool.js';
import * as version from '../src/utils/version.js';
import { createConfig } from './testConfig.js';

function badgeOf(label: string): string {
  return `[![wbfy](https://img.shields.io/badge/wbfy-${label}-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)`;
}

async function runGenerateReadme(dirPath: string, versionLabel: string | undefined): Promise<string> {
  vi.spyOn(version, 'getWbfyVersionLabel').mockReturnValue(versionLabel);
  fsUtil.setRootDirPath(dirPath);
  await generateReadme(createConfig({ dirPath, isRoot: true, packageJson: { name: 'example' } }));
  await promisePool.promiseAll();
  return fs.readFileSync(path.resolve(dirPath, 'README.md'), 'utf8');
}

test('stamps the released version and stays idempotent', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-readme-'));
  fs.writeFileSync(path.resolve(dirPath, 'README.md'), '# example\n\nA description.\n');

  const firstContent = await runGenerateReadme(dirPath, '1.2.3');
  expect(firstContent).toContain(badgeOf('1.2.3'));
  expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(firstContent);
  expect(firstContent.split(badgeOf('1.2.3'))).toHaveLength(2);

  // A newer wbfy replaces the version instead of appending a second badge.
  const updatedContent = await runGenerateReadme(dirPath, '2.0.0');
  expect(updatedContent).toContain(badgeOf('2.0.0'));
  expect(updatedContent).not.toContain('1.2.3');
});

test('marks a run from an unreleased checkout with its commit hash', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-readme-'));
  await runGenerateReadme(dirPath, '1.2.3');

  const localContent = await runGenerateReadme(dirPath, 'abc1234-local');
  expect(localContent).toContain(badgeOf('abc1234--local'));
  expect(localContent).not.toContain('1.2.3');
  expect(readWbfyBadgeLabel(localContent)).toBe('abc1234-local');
});

test('creates a missing README with a version-less badge', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-readme-'));
  expect(await runGenerateReadme(dirPath, undefined)).toBe(`# example\n\n${badgeOf('applied')}\n`);
});

test('resolves a real version label from wbfy itself', () => {
  vi.restoreAllMocks();
  // Either a released version or `<commit hash>-local`, never the unreleased placeholder.
  expect(version.getWbfyVersionLabel()).toMatch(/^(?:\d+\.\d+\.\d+|[0-9a-f]{7,}-local)/u);
});
