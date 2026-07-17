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
