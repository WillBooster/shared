import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { generateGitHubTemplates } from '../src/github/template.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })));
  tempDirs.length = 0;
});

test('does not generate pull request template for non-WillBooster repositories', async () => {
  const dirPath = createTempDir();

  await generateGitHubTemplates(
    createConfig({
      dirPath,
      isWillBoosterRepo: false,
      repository: 'github:exKAZUu/doco-san',
    })
  );
  await promisePool.promiseAll();

  await expect(fs.promises.access(path.join(dirPath, '.github', 'pull_request_template.md'))).rejects.toThrow();
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-github-template-'));
  tempDirs.push(tempDir);
  return tempDir;
}
