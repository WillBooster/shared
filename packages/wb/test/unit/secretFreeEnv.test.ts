import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Project } from '../../src/project.js';
import { createSecretFreeBuildEnv } from '../../src/utils/secretFreeEnv.js';

describe('createSecretFreeBuildEnv', () => {
  let dirPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-secret-free-env-'));
    await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"app"}');
    await fs.writeFile(
      path.join(dirPath, 'fnox.toml'),
      `[secrets]
PUBLIC_URL = { default = "https://dev.example.com" }
API_KEY = { default = "" }
AUTH_SECRET = { provider = "age", value = "ciphertext" }

[profiles.staging.secrets]
PUBLIC_URL = { default = "https://staging.example.com" }
`
    );
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(dirPath, { force: true, recursive: true });
  });

  it('passes fnox defaults, never exported secrets or credentials, and blocks host identities', () => {
    // A Project without loaded env reads process.env, standing in for wb's decrypted environment.
    Object.assign(process.env, {
      API_KEY: 'exported-real-secret',
      AUTH_SECRET: 'decrypted-secret',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      WB_VERSION: 'v1.2.3',
    });
    const env = createSecretFreeBuildEnv(new Project(dirPath, {}, false), 'staging');

    expect(env).toMatchObject({
      API_KEY: '',
      FNOX_AGE_KEY_FILE: '/nonexistent',
      PUBLIC_URL: 'https://staging.example.com',
      WB_ENV: 'staging',
      WB_VERSION: 'v1.2.3',
    });
    expect(env).not.toHaveProperty('AUTH_SECRET');
    expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  });
});
