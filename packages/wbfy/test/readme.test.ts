import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { generateReadme } from '../src/generators/readme.js';
import { fsUtil } from '../src/utils/fsUtil.js';
import { promisePool } from '../src/utils/promisePool.js';
import * as version from '../src/utils/version.js';
import { createConfig } from './testConfig.js';

const legacyBadge =
  '[![wbfy](https://img.shields.io/badge/-wbfy-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)';

function badgeOf(label: string): string {
  return `[![wbfy](https://img.shields.io/badge/wbfy-${label}-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)`;
}

async function withTempDir(test: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-readme-'));
  try {
    await test(dirPath);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
}

// setRootDirPath is process-wide state: leaving a deleted temporary directory behind would confine
// any later test sharing this worker to a repository root that no longer exists.
afterEach(() => {
  fsUtil.setRootDirPath(undefined);
});

async function runGenerateReadme(dirPath: string, versionLabel: string | undefined): Promise<string> {
  vi.spyOn(version, 'getWbfyVersionLabel').mockReturnValue(versionLabel);
  fsUtil.setRootDirPath(dirPath);
  await generateReadme(createConfig({ dirPath, isRoot: true, packageJson: { name: 'example' } }));
  await promisePool.promiseAll();
  return fs.readFileSync(path.resolve(dirPath, 'README.md'), 'utf8');
}

test('stamps the released version and stays idempotent', async () => {
  await withTempDir(async (dirPath) => {
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
});

test.each([
  {
    name: 'leading HTML comment',
    input: '<!--\n\nGenerated file; edit elsewhere.\n-->\n\n# Project\n\nDescription.\n',
    expected: `<!--\n\nGenerated file; edit elsewhere.\n-->\n\n# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'CRLF line endings',
    input: '# Project\r\n\r\nDescription.\r\n',
    expected: `# Project\r\n\r\n${badgeOf('1.2.3')}\r\n\r\nDescription.\r\n`,
  },
  {
    name: 'no blank line after the heading',
    input: '# Project\nDescription.\n',
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
])('inserts the badge after the heading with $name', async ({ input, expected }) => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), input);

    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(expected);
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(expected);
  });
});

test('supersedes a badge whose image URL format changed', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# example\n\n${legacyBadge}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# example\n\n${badgeOf('1.2.3')}\n`);
  });
});

test('marks a run from an unreleased checkout with its commit hash', async () => {
  await withTempDir(async (dirPath) => {
    await runGenerateReadme(dirPath, '1.2.3');

    const localContent = await runGenerateReadme(dirPath, 'abc1234-local');
    expect(localContent).toContain(badgeOf('abc1234--local'));
    expect(localContent).not.toContain('1.2.3');
  });
});

test('creates a missing README with a version-less badge', async () => {
  await withTempDir(async (dirPath) => {
    expect(await runGenerateReadme(dirPath, undefined)).toBe(`# example\n\n${badgeOf('applied')}\n`);
  });
});

test('keeps an existing README that cannot be read', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.resolve(dirPath, 'README.md');
    fs.writeFileSync(filePath, '# example\n\nImportant content.\n');
    // Injected rather than provoked through permission bits: root bypasses those, so a chmod-based
    // test would silently exercise the success path instead in a root container.
    const error: NodeJS.ErrnoException = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    vi.spyOn(fsUtil, 'readFileIfExists').mockRejectedValue(error);

    // generateReadme swallows the read failure, so the unreadable README must stay untouched
    // instead of being overwritten with the generated stub.
    await runGenerateReadme(dirPath, '1.2.3');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# example\n\nImportant content.\n');
  });
});

test('resolves a real version label from wbfy itself', () => {
  vi.restoreAllMocks();
  // Either a released version or `<commit hash>[-dirty]-local`, never the unreleased placeholder.
  expect(version.getWbfyVersionLabel()).toMatch(/^(?:\d+\.\d+\.\d+|[0-9a-f]{7,}(?:-dirty)?-local)$/u);
});
