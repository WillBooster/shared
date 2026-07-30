import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { fixPlaywrightConfig } from '../../src/fixers/playwrightConfig.js';
import { promisePool } from '../../src/utils/promisePool.js';

import { createConfig } from '../helpers/testConfig.js';

test('preserves a custom Playwright web server lifecycle', async () => {
  const customCommand = 'bun run build && bun run next build test/e2e/next-app && bun run next start test/e2e/next-app';
  const generated = await fixConfig(`export default defineConfig({
  webServer: {
    command: '${customCommand}',
    url: 'http://127.0.0.1:3010',
  },
});`);

  expect(generated).toContain(`command: '${customCommand}'`);
});

test('migrates a legacy wbfy-managed Playwright web server command', async () => {
  const generated = await fixConfig(`export default defineConfig({
  webServer: {
    command: 'yarn wb start --mode test',
    url: 'http://127.0.0.1:3010',
  },
});`);

  expect(generated).toContain(`command: 'bun wb start --mode test'`);
});

async function fixConfig(content: string): Promise<string> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-playwright-config-'));
  try {
    const filePath = path.join(dirPath, 'playwright.config.ts');
    fs.writeFileSync(filePath, `import { defineConfig } from '@playwright/test';\n${content}\n`);
    await fixPlaywrightConfig(createConfig({ dirPath, isRoot: true }));
    await promisePool.promiseAll();
    return fs.readFileSync(filePath, 'utf8');
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
}
