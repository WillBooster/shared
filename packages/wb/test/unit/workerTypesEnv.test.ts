import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectWorkerBindingKeyNames, writeWorkerTypesEnvStub } from '../../src/utils/workerTypesEnv.js';

const FNOX_TOML = `[secrets]
PORT = { default = "3031" }
AUTH_SECRET = { provider = "age", value = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCg==" }
BUILD_ONLY = { default = "x", env = false }

[profiles.staging.secrets]
BASIC_AUTH_USERNAME = { provider = "age", value = "c3RhZ2luZy1vbmx5Cg==" }

[providers.age]
recipients = ["age1examplerecipientkey"]
`;

describe('collectWorkerBindingKeyNames', () => {
  it('unions fnox secret keys (every profile) without decryption, env=false, or mise vars', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-worker-types-'));
    await fs.writeFile(path.join(dirPath, 'fnox.toml'), FNOX_TOML);

    try {
      // Sorted union of base + profile fnox secrets. BUILD_ONLY (env = false) is excluded
      // because fnox never exports it; `recipients` is outside any secrets table.
      expect(collectWorkerBindingKeyNames(dirPath, dirPath)).toStrictEqual([
        'AUTH_SECRET',
        'BASIC_AUTH_USERNAME',
        'PORT',
      ]);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('unions ancestor fnox secrets for a nested Worker', async () => {
    const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-worker-types-'));
    const workerDirPath = path.join(rootDirPath, 'packages', 'worker');
    await fs.mkdir(workerDirPath, { recursive: true });
    await fs.writeFile(path.join(rootDirPath, 'fnox.toml'), '[secrets]\nROOT_ONLY = { default = "root" }\n');
    await fs.writeFile(path.join(workerDirPath, 'fnox.toml'), '[secrets]\nNESTED_ONLY = { default = "nested" }\n');

    try {
      // fnox merges the ancestor chain, so every ancestor and workspace declaration must reach the
      // generated Env.
      expect(collectWorkerBindingKeyNames(workerDirPath, rootDirPath)).toStrictEqual(['NESTED_ONLY', 'ROOT_ONLY']);
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });

  it('writes a placeholder-valued stub (no real secret) for wrangler types', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-worker-types-'));
    await fs.writeFile(path.join(dirPath, 'fnox.toml'), FNOX_TOML);
    const outputPath = path.join(dirPath, '.wrangler', 'worker-types.env');

    try {
      writeWorkerTypesEnvStub(dirPath, dirPath, outputPath);

      const content = await fs.readFile(outputPath, 'utf8');
      expect(content).toBe('AUTH_SECRET=1\nBASIC_AUTH_USERNAME=1\nPORT=1\n');
      // Never the encrypted provider value.
      expect(content).not.toContain('YWdlLWVuY3J5cHRpb24');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });
});
