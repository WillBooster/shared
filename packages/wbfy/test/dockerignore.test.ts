import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateDockerignore } from '../src/generators/dockerignore.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

test('ignores temporary directories without ignoring same-prefix files', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-dockerignore-'));
  try {
    await generateDockerignore(createConfig({ dirPath, doesContainDockerfile: true }));
    await promisePool.promiseAll();

    const content = fs.readFileSync(path.join(dirPath, '.dockerignore'), 'utf8');
    expect(content).toContain('**/.tmp-*/**\n');
    expect(content).not.toContain('**/.tmp-*\n');
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});
