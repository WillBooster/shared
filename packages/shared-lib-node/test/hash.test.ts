import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { calculateHashFromFiles, updateHashFromFiles } from '../src/hash.js';

const dirPath1 = path.resolve('test/fixtures', 'test1');
const dirPath2 = path.resolve('test/fixtures', 'test2');
const hashDirPath = path.resolve('test/fixtures', 'temp', 'hash');
fs.rmSync(hashDirPath, { force: true, recursive: true });
fs.mkdirSync(hashDirPath, { recursive: true });

test('calculateHashFromFiles should calculate the hash correctly', async () => {
  const hash = await calculateHashFromFiles(dirPath1);
  const expectedHash =
    '1cbfa1e170e7e6ac645f26fb8e07f3e8d1d6a1ed5e2a73c59a42911887af6ea2918192a7da149aa9917b87cde4b3a16207a0e40e52d8762db702a5fa8f006d83';
  expect(hash).toBe(expectedHash);
});

test('updateHashFromFiles should return true if the hash is updated', async () => {
  const result1 = await updateHashFromFiles(path.resolve(hashDirPath, 'test1.hash'), dirPath1);
  expect(result1).toBe(true);
  const result2 = await updateHashFromFiles(path.resolve(hashDirPath, 'test1.hash'), dirPath2);
  expect(result2).toBe(true);
});

test('updateHashFromFiles should return false if the hash is same', async () => {
  await updateHashFromFiles(path.resolve(hashDirPath, 'test2.hash'), dirPath1);
  const result = await updateHashFromFiles(path.resolve(hashDirPath, 'test2.hash'), dirPath1);
  expect(result).toBe(false);
});
