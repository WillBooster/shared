import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { removeEnvExample } from '../src/fixers/envExample.js';
import { fsUtil } from '../src/utils/fsUtil.js';
import { createConfig } from './testConfig.js';

test('removes .env.example from a managed package', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-env-example-'));
  fsUtil.setRootDirPath(dirPath);
  try {
    const filePath = path.join(dirPath, '.env.example');
    await fs.writeFile(filePath, 'API_KEY=\n');

    await removeEnvExample(createConfig({ dirPath }));

    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    fsUtil.setRootDirPath(undefined);
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});
