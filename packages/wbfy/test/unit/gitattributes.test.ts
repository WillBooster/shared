import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { expect, test } from 'bun:test';

import { generateGitattributes, renormalizeTrackedTextFiles } from '../../src/generators/gitattributes.js';
import { createConfig } from '../helpers/testConfig.js';

test('marks tracked CRLF text for renormalization when introducing text attributes', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitattributes-'));
  try {
    await git(tempDirPath, 'init');
    await git(tempDirPath, 'config', 'user.email', 'agent@willbooster.com');
    await git(tempDirPath, 'config', 'user.name', 'WillBooster Codex');
    await git(tempDirPath, 'config', 'core.autocrlf', 'false');

    fs.writeFileSync(path.join(tempDirPath, 'Deleted.java'), 'class Deleted {\r\n}\r\n');
    fs.writeFileSync(path.join(tempDirPath, 'Main.java'), 'public class Main {\r\n}\r\n');
    fs.writeFileSync(path.join(tempDirPath, 'data.txt'), 'value\r\n');
    fs.mkdirSync(path.join(tempDirPath, 'fixtures'));
    fs.writeFileSync(path.join(tempDirPath, 'fixtures', 'cr.txt'), 'a\n\r\nb\n');
    fs.writeFileSync(path.join(tempDirPath, 'project.vcproj'), '<Project>\r\n</Project>\r\n');
    await git(tempDirPath, 'add', 'Deleted.java', 'Main.java', 'data.txt', 'fixtures', 'project.vcproj');
    await git(tempDirPath, 'commit', '-m', 'test: add CRLF text');
    fs.rmSync(path.join(tempDirPath, 'Deleted.java'));
    fs.writeFileSync(path.join(tempDirPath, 'fixtures', '.gitattributes'), '* text=auto eol=lf\n');

    await generateGitattributes(createConfig({ dirPath: tempDirPath }));
    await renormalizeTrackedTextFiles(tempDirPath);

    expect(await git(tempDirPath, 'ls-files', '--eol', 'Main.java')).toContain('attr/text eol=lf');
    expect(fs.readFileSync(path.join(tempDirPath, 'Main.java'), 'utf8')).not.toContain('\r\n');
    expect(fs.readFileSync(path.join(tempDirPath, 'data.txt'), 'utf8')).toContain('\r\n');
    expect(fs.readFileSync(path.join(tempDirPath, 'fixtures', 'cr.txt'), 'utf8')).toBe('a\n\r\nb\n');
    expect(fs.readFileSync(path.join(tempDirPath, 'project.vcproj'), 'utf8')).not.toContain('\r\n');
    expect(await git(tempDirPath, 'status', '--short')).toContain(' M Main.java');
    await git(tempDirPath, 'add', '-A');
    expect(await git(tempDirPath, 'ls-files', '--eol', 'Main.java')).toMatch(/^i\/lf\s/u);
    expect(await git(tempDirPath, 'ls-files', '--eol', 'fixtures/cr.txt')).toMatch(/^i\/mixed\s/u);
    expect(await git(tempDirPath, 'ls-files', '--eol', 'project.vcproj')).toMatch(/^i\/lf\s/u);
    await git(tempDirPath, 'commit', '-m', 'test: apply attributes');
    fs.rmSync(path.join(tempDirPath, 'project.vcproj'));
    await git(tempDirPath, 'checkout', 'HEAD', '--', 'project.vcproj');
    expect(fs.readFileSync(path.join(tempDirPath, 'project.vcproj'), 'utf8')).toContain('\r\n');
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('reads tracked EOL metadata beyond Node default buffer', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitattributes-large-'));
  try {
    await git(tempDirPath, 'init');
    await git(tempDirPath, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(tempDirPath, 'zzzz.java'), 'class Last {\r\n}\r\n');
    await git(tempDirPath, 'add', 'zzzz.java');
    fs.writeFileSync(path.join(tempDirPath, '.gitattributes'), '*.java text eol=lf\n');

    const emptyBlob = await git(tempDirPath, 'hash-object', '-w', '--stdin');
    const indexEntries = Array.from(
      { length: 12_000 },
      (_, index) => `100644 ${emptyBlob.trim()}\tbulk/${index.toString().padStart(5, '0')}-${'x'.repeat(64)}.txt\n`
    ).join('');
    const updateIndex = await spawnAsync('git', ['update-index', '--index-info'], {
      cwd: tempDirPath,
      input: indexEntries,
    });
    expect(updateIndex.status, updateIndex.stderr).toBe(0);
    const eolMetadata = await git(tempDirPath, 'ls-files', '--eol', '-z');
    expect(Buffer.byteLength(eolMetadata)).toBeGreaterThan(1024 * 1024);
    expect(eolMetadata).toContain('\tzzzz.java\0');

    await renormalizeTrackedTextFiles(tempDirPath);

    expect(fs.readFileSync(path.join(tempDirPath, 'zzzz.java'), 'utf8')).not.toContain('\r\n');
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('skips renormalization outside a Git repository', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitattributes-no-git-'));
  try {
    await renormalizeTrackedTextFiles(tempDirPath);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnAsync('git', args, { cwd });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
