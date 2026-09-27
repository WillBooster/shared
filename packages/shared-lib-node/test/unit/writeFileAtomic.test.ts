import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { writeFileAtomic } from '../../src/writeFileAtomic.js';

let dirPath: string;

beforeEach(async () => {
  dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'write-file-atomic-'));
});

afterEach(async () => {
  await fs.promises.rm(dirPath, { force: true, recursive: true });
});

test('writeFileAtomic creates parent directories, replaces content, and leaves no temporary file', async () => {
  const filePath = path.join(dirPath, 'nested', 'state.json');
  await writeFileAtomic(filePath, 'old');
  await Promise.all([
    writeFileAtomic(filePath, 'new1', { mode: 0o600 }),
    writeFileAtomic(filePath, 'new2', { mode: 0o600 }),
  ]);
  expect(['new1', 'new2']).toContain(await fs.promises.readFile(filePath, 'utf8'));
  const stat = await fs.promises.stat(filePath);
  expect(stat.mode & 0o777).toBe(0o600);
  expect(await fs.promises.readdir(path.dirname(filePath))).toEqual(['state.json']);
});

test('writeFileAtomic keeps the permissions of the replaced file when no mode is given', async () => {
  const filePath = path.join(dirPath, 'secret');
  await fs.promises.writeFile(filePath, 'old', { mode: 0o600 });
  await writeFileAtomic(filePath, 'new');
  const stat = await fs.promises.stat(filePath);
  expect(stat.mode & 0o777).toBe(0o600);
});

test('writeFileAtomic writes a file whose name is at the length limit', async () => {
  const filePath = path.join(dirPath, 'a'.repeat(255));
  await writeFileAtomic(filePath, 'content');
  expect(await fs.promises.readFile(filePath, 'utf8')).toBe('content');
});

test('writeFileAtomic removes its temporary file when the rename fails', async () => {
  const filePath = path.join(dirPath, 'target');
  await fs.promises.mkdir(path.join(filePath, 'child'), { recursive: true });
  const error = await writeFileAtomic(filePath, 'content').catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(await fs.promises.readdir(dirPath)).toEqual(['target']);
});
