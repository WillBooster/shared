import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { fsUtil } from '../src/utils/fsUtil.js';

test('generateFile refuses to write through a symlinked parent directory', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fsutil-'));
  try {
    const repoDirPath = path.join(tempDirPath, 'repo');
    const outsideDirPath = path.join(tempDirPath, 'outside');
    fs.mkdirSync(repoDirPath);
    fs.mkdirSync(outsideDirPath);
    fs.symlinkSync(outsideDirPath, path.join(repoDirPath, '.vscode'));
    fsUtil.setRootDirPath(repoDirPath);
    await fsUtil.generateFile(path.join(repoDirPath, '.vscode', 'settings.json'), '{}');
    expect(fs.existsSync(path.join(outsideDirPath, 'settings.json'))).toBe(false);
  } finally {
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('readFileConfinedIfExists rejects sources resolving outside the repository but reads in-repo symlinks', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fsutil-'));
  try {
    const repoDirPath = path.join(tempDirPath, 'repo');
    const outsideDirPath = path.join(tempDirPath, 'outside');
    fs.mkdirSync(repoDirPath);
    fs.mkdirSync(outsideDirPath);
    fs.writeFileSync(path.join(outsideDirPath, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outsideDirPath, 'secret.txt'), path.join(repoDirPath, '.renovaterc.json'));
    fs.symlinkSync(outsideDirPath, path.join(repoDirPath, 'linked'));
    fs.writeFileSync(path.join(repoDirPath, 'regular.txt'), 'regular');
    fs.writeFileSync(path.join(repoDirPath, '.nvmrc'), '22.11.0');
    fs.symlinkSync(path.join(repoDirPath, '.nvmrc'), path.join(repoDirPath, '.node-version'));
    fs.symlinkSync(path.join(repoDirPath, 'nonexistent.txt'), path.join(repoDirPath, 'dangling.txt'));
    fsUtil.setRootDirPath(repoDirPath);
    expect(await fsUtil.readFileConfinedIfExists(path.join(repoDirPath, '.renovaterc.json'))).toBeUndefined();
    expect(await fsUtil.readFileConfinedIfExists(path.join(repoDirPath, 'linked', 'secret.txt'))).toBeUndefined();
    expect(await fsUtil.readFileConfinedIfExists(path.join(repoDirPath, 'missing.txt'))).toBeUndefined();
    expect(await fsUtil.readFileConfinedIfExists(path.join(repoDirPath, 'dangling.txt'))).toBeUndefined();
    expect(await fsUtil.readFileConfinedIfExists(path.join(repoDirPath, 'regular.txt'))).toBe('regular');
    // A symlink whose target stays inside the repository is a legitimate source and is read.
    expect(await fsUtil.readFileConfinedIfExists(path.join(repoDirPath, '.node-version'))).toBe('22.11.0');
  } finally {
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('removeConfined refuses to delete through a symlinked directory but removes symlink entries', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fsutil-'));
  try {
    const repoDirPath = path.join(tempDirPath, 'repo');
    const outsideDirPath = path.join(tempDirPath, 'outside');
    fs.mkdirSync(repoDirPath);
    fs.mkdirSync(outsideDirPath);
    fs.writeFileSync(path.join(outsideDirPath, 'workflow.yml'), 'name: x');
    fs.symlinkSync(outsideDirPath, path.join(repoDirPath, 'workflows'));
    fsUtil.setRootDirPath(repoDirPath);
    // Deletion through the symlinked directory is refused; the outside file survives.
    expect(await fsUtil.removeConfined(path.join(repoDirPath, 'workflows', 'workflow.yml'))).toBe(false);
    expect(fs.existsSync(path.join(outsideDirPath, 'workflow.yml'))).toBe(true);
    // Removing the symlink ENTRY itself deletes only the link, never its target.
    expect(await fsUtil.removeConfined(path.join(repoDirPath, 'workflows'))).toBe(true);
    expect(fs.existsSync(path.join(repoDirPath, 'workflows'))).toBe(false);
    expect(fs.existsSync(path.join(outsideDirPath, 'workflow.yml'))).toBe(true);
    // A regular in-repository file is removed.
    fs.writeFileSync(path.join(repoDirPath, 'inside.txt'), 'inside');
    expect(await fsUtil.removeConfined(path.join(repoDirPath, 'inside.txt'))).toBe(true);
    expect(fs.existsSync(path.join(repoDirPath, 'inside.txt'))).toBe(false);
  } finally {
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('generateFile writes normally inside the confined repository root', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fsutil-'));
  try {
    fsUtil.setRootDirPath(tempDirPath);
    const filePath = path.join(tempDirPath, '.vscode', 'settings.json');
    await fsUtil.generateFile(filePath, '{}');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{}\n');
  } finally {
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});
