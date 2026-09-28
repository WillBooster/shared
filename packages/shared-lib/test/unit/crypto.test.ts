import { createHash } from 'node:crypto';

import { expect, test } from 'bun:test';

import { sha256HexAsync, timingSafeEqualStringAsync } from '../../src/crypto.js';

test('sha256HexAsync matches the digests node:crypto has already stored', async () => {
  // Existing token hashes in databases were made by `createHash('sha256')`, which encodes strings as UTF-8.
  for (const data of ['', 'token', '日本語🙂', '\uD800']) {
    expect(await sha256HexAsync(data)).toBe(createHash('sha256').update(data).digest('hex'));
  }
  const bytes = new Uint8Array([0, 1, 254, 255]);
  expect(await sha256HexAsync(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  const sharedBytes = new Uint8Array(new SharedArrayBuffer(bytes.length));
  sharedBytes.set(bytes);
  expect(await sha256HexAsync(sharedBytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
});

test('timingSafeEqualStringAsync compares strings of any lengths', async () => {
  expect(await timingSafeEqualStringAsync('secret', 'secret')).toBe(true);
  expect(await timingSafeEqualStringAsync('secret', 'secreT')).toBe(false);
  expect(await timingSafeEqualStringAsync('secret', 'secret-longer')).toBe(false);
  expect(await timingSafeEqualStringAsync('', '')).toBe(true);
  expect(await timingSafeEqualStringAsync('日本語🙂', '日本語🙂')).toBe(true);
  expect(await timingSafeEqualStringAsync('\uD800', '\uD801')).toBe(false);
});
