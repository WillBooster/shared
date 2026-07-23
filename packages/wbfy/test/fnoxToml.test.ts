import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateFnoxToml } from '../src/generators/fnoxToml.js';
import { createConfig } from './testConfig.js';

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
    expect(process.exitCode ?? 0).toBe(0);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});
