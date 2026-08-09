import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateGitattributes, renormalizeTrackedTextFiles } from '../../src/generators/gitattributes.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

test('marks tracked CRLF text for renormalization when introducing text attributes', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitattributes-'));
  try {
    git(tempDirPath, 'init');
    git(tempDirPath, 'config', 'user.email', 'agent@willbooster.com');
    git(tempDirPath, 'config', 'user.name', 'WillBooster Codex');
    git(tempDirPath, 'config', 'core.autocrlf', 'false');

    fs.writeFileSync(path.join(tempDirPath, 'Deleted.java'), 'class Deleted {\r\n}\r\n');
    fs.writeFileSync(path.join(tempDirPath, 'Main.java'), 'public class Main {\r\n}\r\n');
    fs.writeFileSync(path.join(tempDirPath, 'data.txt'), 'value\r\n');
    fs.writeFileSync(path.join(tempDirPath, 'project.vcproj'), '<Project>\r\n</Project>\r\n');
    git(tempDirPath, 'add', 'Deleted.java', 'Main.java', 'data.txt', 'project.vcproj');
    git(tempDirPath, 'commit', '-m', 'test: add CRLF text');
    fs.rmSync(path.join(tempDirPath, 'Deleted.java'));

    await generateGitattributes(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    renormalizeTrackedTextFiles(tempDirPath);

    expect(git(tempDirPath, 'ls-files', '--eol', 'Main.java')).toContain('attr/text eol=lf');
    expect(fs.readFileSync(path.join(tempDirPath, 'Main.java'), 'utf8')).not.toContain('\r\n');
    expect(fs.readFileSync(path.join(tempDirPath, 'data.txt'), 'utf8')).toContain('\r\n');
    expect(fs.readFileSync(path.join(tempDirPath, 'project.vcproj'), 'utf8')).not.toContain('\r\n');
    expect(git(tempDirPath, 'status', '--short')).toContain(' M Main.java');
    git(tempDirPath, 'add', '-A');
    expect(git(tempDirPath, 'ls-files', '--eol', 'Main.java')).toMatch(/^i\/lf\s/u);
    expect(git(tempDirPath, 'ls-files', '--eol', 'project.vcproj')).toMatch(/^i\/lf\s/u);
    git(tempDirPath, 'commit', '-m', 'test: apply attributes');
    fs.rmSync(path.join(tempDirPath, 'project.vcproj'));
    git(tempDirPath, 'checkout', 'HEAD', '--', 'project.vcproj');
    expect(fs.readFileSync(path.join(tempDirPath, 'project.vcproj'), 'utf8')).toContain('\r\n');
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('reads tracked EOL metadata beyond Node default buffer', () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitattributes-large-'));
  try {
    git(tempDirPath, 'init');
    git(tempDirPath, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(tempDirPath, 'zzzz.java'), 'class Last {\r\n}\r\n');
    git(tempDirPath, 'add', 'zzzz.java');
    fs.writeFileSync(path.join(tempDirPath, '.gitattributes'), '*.java text eol=lf\n');

    const emptyBlob = child_process.execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: tempDirPath,
      encoding: 'utf8',
      input: '',
    });
    const indexEntries = Array.from(
      { length: 12_000 },
      (_, index) => `100644 ${emptyBlob.trim()}\tbulk/${index.toString().padStart(5, '0')}-${'x'.repeat(64)}.txt\n`
    ).join('');
    child_process.execFileSync('git', ['update-index', '--index-info'], {
      cwd: tempDirPath,
      input: indexEntries,
      maxBuffer: 4 * 1024 * 1024,
    });
    const eolMetadata = child_process.execFileSync('git', ['ls-files', '--eol', '-z'], {
      cwd: tempDirPath,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(Buffer.byteLength(eolMetadata)).toBeGreaterThan(1024 * 1024);
    expect(eolMetadata).toContain('\tzzzz.java\0');

    renormalizeTrackedTextFiles(tempDirPath);

    expect(fs.readFileSync(path.join(tempDirPath, 'zzzz.java'), 'utf8')).not.toContain('\r\n');
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return child_process.execFileSync('git', args, { cwd, encoding: 'utf8' });
}
