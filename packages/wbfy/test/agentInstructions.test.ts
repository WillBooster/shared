import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { generateAgentInstructions } from '../src/generators/agents.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })));
  tempDirs.length = 0;
});

test('mentions wb test server startup for Playwright projects on the first run', async () => {
  const dirPath = createTempDir();
  const config = createConfig({
    dirPath,
    isBun: true,
    isRoot: true,
    depending: {
      ...createConfig().depending,
      playwrightTest: true,
    },
    packageJson: {
      name: 'app',
      description: 'App',
    },
  });

  await generateAgentInstructions(config, [config]);
  await promisePool.promiseAll();

  const content = await fs.promises.readFile(path.join(dirPath, 'AGENTS.md'), 'utf8');
  expect(content).toContain('Use `bun wb start --mode test` to launch a web server for debugging or testing.');
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-agent-instructions-'));
  tempDirs.push(tempDir);
  return tempDir;
}
