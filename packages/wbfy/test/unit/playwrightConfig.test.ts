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

test.each(['chore: willboosterify this repo', 'chore: willboosterify this repo (#951)'])(
  'restores a custom command overwritten by %s',
  async (wbfyCommitSubject) => {
    const dirPath = createGitRepository();
    try {
      const customCommand = getCustomCommand('next-app');
      commitConfig(dirPath, customCommand, 'test: add custom Playwright fixture');
      commitConfig(dirPath, 'bun wb start --mode test', wbfyCommitSubject);

      await fixAndReadConfig(dirPath);

      expect(fs.readFileSync(path.join(dirPath, 'playwright.config.ts'), 'utf8')).toContain(
        `command: '${customCommand}'`
      );
    } finally {
      fs.rmSync(dirPath, { force: true, recursive: true });
    }
  }
);

test('restores an overwritten command in a nested workspace package', async () => {
  const dirPath = createGitRepository();
  const packageDirPath = path.join(dirPath, 'packages', '日本語');
  try {
    const customCommand = getCustomCommand('nested-app');
    commitConfig(packageDirPath, customCommand, 'test: add custom Playwright fixture');
    commitConfig(packageDirPath, 'bun wb start --mode test', 'chore: willboosterify this repo');

    await fixAndReadConfig(packageDirPath);

    expect(fs.readFileSync(path.join(packageDirPath, 'playwright.config.ts'), 'utf8')).toContain(
      `command: '${customCommand}'`
    );
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

test('continues through later wbfy-generated command migrations', async () => {
  const dirPath = createGitRepository();
  try {
    const customCommand = getCustomCommand('migrated-app');
    commitConfig(dirPath, customCommand, 'test: add custom Playwright fixture');
    commitConfig(dirPath, 'yarn start-test-server', 'chore: willboosterify this repo');
    commitConfig(dirPath, 'bun wb start --mode test', 'feat: migrate repository to Bun');

    const generated = await fixAndReadConfig(dirPath);

    expect(generated).toContain(`command: '${customCommand}'`);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

test('does not recover across an intermediate revision without a web server command', async () => {
  const dirPath = createGitRepository();
  try {
    commitConfig(dirPath, getCustomCommand('removed-app'), 'test: add custom Playwright fixture');
    commitConfig(dirPath, 'bun wb start --mode test', 'chore: willboosterify this repo');
    commitRawConfig(
      dirPath,
      `import { defineConfig } from '@playwright/test';
export default defineConfig({ use: { baseURL: 'http://127.0.0.1:3010' } });
`,
      'refactor: remove the managed web server'
    );
    commitConfig(dirPath, 'bun wb start --mode test', 'chore: willboosterify this repo');

    const generated = await fixAndReadConfig(dirPath);

    expect(generated).toContain(`command: 'bun wb start --mode test'`);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

test('follows a Playwright config moved after the overwrite', async () => {
  const dirPath = createGitRepository();
  const packageDirPath = path.join(dirPath, 'packages', 'app');
  try {
    const customCommand = getCustomCommand('moved-app');
    commitConfig(dirPath, customCommand, 'test: add custom Playwright fixture');
    commitConfig(dirPath, 'bun wb start --mode test', 'chore: willboosterify this repo');
    fs.mkdirSync(packageDirPath, { recursive: true });
    git(dirPath, 'mv', 'playwright.config.ts', 'packages/app/playwright.config.ts');
    git(dirPath, 'commit', '--quiet', '-m', 'refactor: move Playwright fixture');

    await fixAndReadConfig(packageDirPath);

    expect(fs.readFileSync(path.join(packageDirPath, 'playwright.config.ts'), 'utf8')).toContain(
      `command: '${customCommand}'`
    );
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

test('does not restore a command whose referenced identifier was renamed later', async () => {
  const dirPath = createGitRepository();
  try {
    commitRawConfig(
      dirPath,
      createTemplateConfig('port', '`bun run next start test/e2e/next-app --port ${port}`'),
      'test: add custom Playwright fixture'
    );
    commitRawConfig(
      dirPath,
      createTemplateConfig('port', "'bun wb start --mode test'"),
      'chore: willboosterify this repo'
    );
    commitRawConfig(
      dirPath,
      createTemplateConfig('PORT', "'bun wb start --mode test'"),
      'refactor: rename the port constant'
    );

    const generated = await fixAndReadConfig(dirPath);

    expect(generated).toContain(`command: 'bun wb start --mode test'`);
    expect(generated).not.toContain('${port}');
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

test('does not restore an obsolete overwrite after a deliberate command transition', async () => {
  const dirPath = createGitRepository();
  try {
    commitConfig(dirPath, getCustomCommand('original-app'), 'test: add original Playwright fixture');
    commitConfig(dirPath, 'bun wb start --mode test', 'chore: willboosterify this repo');
    commitConfig(dirPath, getCustomCommand('replacement-app'), 'fix: change Playwright fixture');
    commitConfig(dirPath, 'bun wb start --mode test', 'fix: adopt the standard test server');

    const generated = await fixAndReadConfig(dirPath);

    expect(generated).toContain(`command: 'bun wb start --mode test'`);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

function createGitRepository(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-playwright-config-'));
  git(dirPath, 'init', '--quiet', '--initial-branch=main');
  git(dirPath, 'config', 'user.email', 'test@example.com');
  git(dirPath, 'config', 'user.name', 'Test');
  return dirPath;
}

function commitConfig(dirPath: string, command: string, subject: string): void {
  writeConfig(dirPath, command);
  commitPlaywrightConfig(dirPath, subject);
}

function commitRawConfig(dirPath: string, content: string, subject: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'playwright.config.ts'), content);
  commitPlaywrightConfig(dirPath, subject);
}

function commitPlaywrightConfig(dirPath: string, subject: string): void {
  const repositoryDirPath = findRepositoryDirPath(dirPath);
  git(repositoryDirPath, 'add', path.relative(repositoryDirPath, path.join(dirPath, 'playwright.config.ts')));
  git(repositoryDirPath, 'commit', '--quiet', '-m', subject);
}

function findRepositoryDirPath(dirPath: string): string {
  for (let currentDirPath = dirPath; ; currentDirPath = path.dirname(currentDirPath)) {
    if (fs.existsSync(path.join(currentDirPath, '.git'))) return currentDirPath;
  }
}

function getCustomCommand(appDirName: string): string {
  return `bun run build && bun run next build test/e2e/${appDirName} && bun run next start test/e2e/${appDirName}`;
}

function createTemplateConfig(constantName: string, commandExpression: string): string {
  return `import { defineConfig } from '@playwright/test';
const ${constantName} = 3010;
export default defineConfig({
  webServer: {
    command: ${commandExpression},
    url: \`http://127.0.0.1:\${${constantName}}\`,
  },
});
`;
}

async function fixAndReadConfig(dirPath: string): Promise<string> {
  await fixPlaywrightConfig(createConfig({ dirPath, isRoot: fs.existsSync(path.join(dirPath, '.git')) }));
  await promisePool.promiseAll();
  return fs.readFileSync(path.join(dirPath, 'playwright.config.ts'), 'utf8');
}

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
  fs.mkdirSync(dirPath, { recursive: true });
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
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
}
