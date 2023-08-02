import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from 'vitest';

import { calculateHashFromFiles, updateHashFromFiles } from '../src/hash.js';

const dirPath1 = path.resolve('test-fixtures', 'test1');
const dirPath2 = path.resolve('test-fixtures', 'test2');
const hashDirPath = path.resolve('test-fixtures', 'temp');
fs.rmSync(hashDirPath, { force: true, recursive: true });
fs.mkdirSync(hashDirPath, { recursive: true });

test('calculateHashFromFiles should calculate the hash correctly', async () => {
  const hash = await calculateHashFromFiles(dirPath1);
  const expectedHash =
    'd20f0ea2288e226b4477c3b5e5dd7a028831e4918491faa819a5bd6737882791a57010d1e109216bf579331ab212701d84431b1991eaddc774c63fb31ef2171f';
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
