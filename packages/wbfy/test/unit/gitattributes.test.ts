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
    fs.writeFileSync(path.join(tempDirPath, 'project.vcproj'), '<Project>\r\n</Project>\r\n');
    git(tempDirPath, 'add', 'Deleted.java', 'Main.java', 'project.vcproj');
    git(tempDirPath, 'commit', '-m', 'test: add CRLF text');
    fs.rmSync(path.join(tempDirPath, 'Deleted.java'));

    await generateGitattributes(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    renormalizeTrackedTextFiles(tempDirPath);

    expect(git(tempDirPath, 'ls-files', '--eol', 'Main.java')).toContain('attr/text eol=lf');
    expect(fs.readFileSync(path.join(tempDirPath, 'Main.java'), 'utf8')).not.toContain('\r\n');
    expect(fs.readFileSync(path.join(tempDirPath, 'project.vcproj'), 'utf8')).toContain('\r\n');
    expect(git(tempDirPath, 'status', '--short')).toContain(' M Main.java');
    git(tempDirPath, 'add', '-A');
    expect(git(tempDirPath, 'ls-files', '--eol', 'Main.java')).toMatch(/^i\/lf\s/u);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return child_process.execFileSync('git', args, { cwd, encoding: 'utf8' });
}
