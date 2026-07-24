import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateFnoxToml, hasFnoxSyncFailed } from '../../src/generators/fnoxToml.js';
import { createConfig } from '../helpers/testConfig.js';

test('keeps the age recipients of a repository outside the WillBooster organizations', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fnox-'));
  try {
    const originalContent = `[providers.age]
type = "age"
recipients = [
  "age1j2354xhvm3fv9y77t5g6y3q8mexgk2mf00tgrkzgp73tynrvz55s8auayw", # owner
  "age19dsxzka9av9h242rhqmexd6amp4k350xqkfufyhmydacceegh5lqa9l605", # ci-owner
]

[secrets]
`;
    fs.writeFileSync(path.join(dirPath, 'fnox.toml'), originalContent);
    await generateFnoxToml(createConfig({ dirPath, repository: 'github:example/example', isWillBoosterRepo: false }));

    expect(fs.readFileSync(path.join(dirPath, 'fnox.toml'), 'utf8')).toBe(originalContent);
    // Assert the synchronization flag itself, which generateFnoxToml resets on every call. The
    // process-global process.exitCode is never reset and every failure path of this module writes
    // it, so a failure-path test added to this file would contaminate that assertion.
    expect(hasFnoxSyncFailed()).toBe(false);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});
