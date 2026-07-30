import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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

test.each(['wb start --mode test', 'yarn wb start --mode test', 'bun start-test-server', 'yarn start-test-server'])(
  'migrates the legacy wbfy-managed Playwright web server command %s',
  async (command) => {
    const generated = await fixConfig(`export default defineConfig({
  webServer: {
    command: '${command}',
    url: 'http://127.0.0.1:3010',
  },
});`);

    expect(generated).toContain(`command: 'bun wb start --mode test'`);
  }
);

test('restores a custom command overwritten by an earlier wbfy commit', async () => {
  const customCommand = 'bun run build && bun run next build test/e2e/next-app && bun run next start test/e2e/next-app';
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-playwright-config-'));
  try {
    git(dirPath, 'init', '--quiet');
    git(dirPath, 'config', 'user.email', 'test@example.com');
    git(dirPath, 'config', 'user.name', 'Test');
    writeConfig(dirPath, customCommand);
    git(dirPath, 'add', 'playwright.config.ts');
    git(dirPath, 'commit', '--quiet', '-m', 'test: add custom Playwright fixture');

    writeConfig(dirPath, 'bun wb start --mode test');
    git(dirPath, 'add', 'playwright.config.ts');
    git(dirPath, 'commit', '--quiet', '-m', 'chore: willboosterify this repo');

    await fixPlaywrightConfig(createConfig({ dirPath, isRoot: true }));
    await promisePool.promiseAll();

    expect(fs.readFileSync(path.join(dirPath, 'playwright.config.ts'), 'utf8')).toContain(
      `command: '${customCommand}'`
    );
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
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

function writeConfig(dirPath: string, command: string): void {
  fs.writeFileSync(
    path.join(dirPath, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  webServer: {
    command: '${command}',
    url: 'http://127.0.0.1:3010',
  },
});
`
  );
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd });
}
