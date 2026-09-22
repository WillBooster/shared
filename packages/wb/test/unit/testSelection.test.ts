import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeAll, expect, it } from 'bun:test';

import { buildWb } from '../helpers/build.js';

const cliPath = path.resolve('bin/index.js');
const fixtures: string[] = [];

beforeAll(buildWb, 120_000);
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it.each(['unit', 'e2e'])(
  'selects a file and case in %s through test and verify --full',
  async (suite) => {
    const dir = await createFixture();
    for (const command of [['test'], ['verify', '--full']]) {
      const result = runCli(dir, [...command, `test/${suite}/selected.test.ts`, '--grep', 'selected case$']);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
      await fs.rm(path.join(dir, 'executed'));
    }
  },
  60_000
);

it('applies a name-only filter to both suites and excludes debug tests', async () => {
  const dir = await createFixture();
  const result = runCli(dir, ['test', '--grep', 'selected case$']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selectedselected');
}, 60_000);

it.each(['unit', 'e2e'])(
  'continues past an unmatched suite to run %s cases',
  async (suite) => {
    const dir = await createFixture();
    const file = path.join(dir, 'test', suite, 'selected.test.ts');
    const source = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, source.replace('selected case', 'unique selected case'));
    const result = runCli(dir, ['test', '--grep', 'unique selected case$']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
  },
  60_000
);

it.each(['plain', 'http', 'worker'].flatMap((kind) => ['headless', 'docker'].map((e2e) => ({ kind, e2e }))))(
  'rejects unsupported $e2e options before running selected $kind tests',
  async ({ kind, e2e }) => {
    const dir = await createFixture();
    if (kind === 'http') {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'selection-fixture', packageManager: 'bun@1.4.2', dependencies: { express: '5.1.0' } })
      );
    } else if (kind === 'worker') {
      await fs.writeFile(
        path.join(dir, 'wrangler.jsonc'),
        JSON.stringify({ name: 'selection-fixture', main: 'src/index.ts', compatibility_date: '2026-09-01' })
      );
    }
    const result = runCli(dir, ['test', '--e2e', e2e, '--grep', 'selected case$', '--', '--workers=1']);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'Cannot forward Playwright option to the unit-test runner: --workers=1'
    );
    expect(await fs.exists(path.join(dir, 'executed'))).toBe(false);
  },
  60_000
);

it('applies supported forwarded selections to HTTP-server E2E tests', async () => {
  const dir = await createFixture();
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'selection-fixture',
      packageManager: 'bun@1.4.2',
      dependencies: { express: '5.1.0' },
      scripts: { build: 'true', 'test/e2e-additional': 'exit 9' },
    })
  );
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(
    path.join(dir, 'src/index.ts'),
    "require('node:http').createServer((_, res) => res.end('ready')).listen(Number(process.env.PORT));"
  );
  await fs.writeFile(
    path.join(dir, 'test/e2e/selected.test.ts'),
    "import { test, expect } from 'bun:test'; import fs from 'node:fs'; test('selected case', async () => { expect(await (await fetch('http://localhost:' + process.env.PORT)).text()).toBe('ready'); fs.appendFileSync('executed', 'selected'); });"
  );
  await fs.writeFile(
    path.join(dir, 'test/e2e/other.test.ts'),
    "import { test } from 'bun:test'; test('selected case', () => { throw new Error('Unselected file ran'); });"
  );
  for (const selection of [
    ['--grep', 'selected case$', '--', 'test/e2e/selected.test.ts'],
    ['--', 'test/e2e/selected.test.ts'],
    ['--', 'test/e2e/selected.test.ts', '--grep', 'selected case$'],
  ]) {
    const result = runCli(dir, ['test', ...selection]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
    await fs.rm(path.join(dir, 'executed'));
  }
  await fs.writeFile(
    path.join(dir, 'test/e2e/other.test.ts'),
    "import { test } from 'bun:test'; test('other file', () => {});"
  );
  const unfiltered = runCli(dir, ['test', '--', '--workers=1']);
  expect(unfiltered.status, unfiltered.stdout + unfiltered.stderr).toBe(9);
}, 60_000);

it.each(['vitest', '@playwright/test'])(
  'filters real %s cases through test and full verification',
  async (runner) => {
    const dir = await createFixture();
    const playwright = runner === '@playwright/test';
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'selection-fixture',
        type: 'module',
        packageManager: 'bun@1.4.2',
        devDependencies: { [runner]: playwright ? '1.63.0' : '4.1.11' },
        ...(playwright ? { scripts: { 'test/e2e-additional': 'exit 9' } } : {}),
      })
    );
    const install = spawnSync('bun', ['install'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    expect(install.status, install.stdout + install.stderr).toBe(0);
    if (playwright) {
      await fs.writeFile(
        path.join(dir, 'playwright.config.ts'),
        "export default { testDir: './test/e2e', webServer: [] };"
      );
    }
    const suite = playwright ? 'e2e' : 'unit';
    for (const file of ['selected.test.ts', 'other.test.ts']) {
      const filePath = path.join(dir, 'test', suite, file);
      const source = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(filePath, source.replace('bun:test', runner));
    }
    for (const command of [['test'], ['verify', '--full']]) {
      const result = runCli(dir, [...command, `test/${suite}/selected.test.ts`, '--grep', 'selected case$']);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
      await fs.rm(path.join(dir, 'executed'));
    }
    if (!playwright) {
      for (const command of [['test'], ['verify', '--full']]) {
        const noMatch = runCli(dir, [...command, 'test/unit/selected.test.ts', '--grep', 'absent case']);
        expect(noMatch.status, noMatch.stdout + noMatch.stderr).toBe(0);
        expect(await fs.exists(path.join(dir, 'executed'))).toBe(false);
        expect(noMatch.stdout).toContain('Name filter "absent case" (runner may pass with no matches)');
      }
    }
    if (playwright) {
      const separatedResult = runCli(dir, [
        'test',
        '--grep',
        'selected case$',
        '--',
        '--workers=1',
        '--',
        'test/e2e/selected.test.ts',
      ]);
      expect(separatedResult.status, separatedResult.stdout + separatedResult.stderr).toBe(0);
      expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
      await fs.rm(path.join(dir, 'executed'));
      const invertedResult = runCli(dir, ['test', '--', '-Gother']);
      expect(invertedResult.status, invertedResult.stdout + invertedResult.stderr).toBe(0);
      expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
      await fs.rm(path.join(dir, 'executed'));
      const unitFile = path.join(dir, 'test/unit/selected.test.ts');
      const unitSource = await fs.readFile(unitFile, 'utf8');
      await fs.writeFile(unitFile, unitSource.replace('selected case', 'unit selected case'));
      for (const forwarded of [
        [],
        ['--', '--workers=1'],
        ['--', '-G', 'other'],
        ['--', '--grep-invert', 'other'],
        ['--', '--add-reporter', 'json'],
        ['--', '--last-failed-file', 'last-failed.json'],
        ['--', '--run-agents', 'none'],
        ['--', '--debug', 'cli'],
        ['--', '-u', 'none'],
      ]) {
        const unitResult = runCli(dir, ['test', '--grep', 'unit selected case$', ...forwarded]);
        expect(unitResult.status, unitResult.stdout + unitResult.stderr).toBe(0);
        expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
        await fs.rm(path.join(dir, 'executed'));
      }
      await fs.writeFile(
        path.join(dir, 'playwright.config.ts'),
        "export default { testDir: './test/e2e', webServer: [], projects: [{ name: 'p1' }, { name: 'p2' }] };"
      );
      const projectsResult = runCli(dir, ['test', '--grep', 'unit selected case$', '--', '--project', 'p1', 'p2']);
      expect(projectsResult.status, projectsResult.stdout + projectsResult.stderr).toBe(0);
      expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
      await fs.rm(path.join(dir, 'executed'));
      const projectFile = path.join(dir, 'test/e2e/project.test.ts');
      await fs.writeFile(
        projectFile,
        "import { test } from '@playwright/test'; import fs from 'node:fs'; test('project case', () => fs.appendFileSync('executed', 'project'));"
      );
      const projectPathResult = runCli(dir, ['test', '--', '--project=p1', 'test/e2e/project.test.ts']);
      expect(projectPathResult.status, projectPathResult.stdout + projectPathResult.stderr).toBe(0);
      expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('project');
      await fs.rm(path.join(dir, 'executed'));
      await fs.rm(projectFile);
      for (const file of ['selected.test.ts', 'other.test.ts']) {
        await fs.writeFile(
          path.join(dir, 'test/e2e', file),
          "import { test } from '@playwright/test'; test('passes', () => {});"
        );
      }
      for (const forwarded of [
        ['--workers=1'],
        ['--add-reporter', 'json'],
        ['--last-failed-file', 'last-failed.json'],
        ['--run-agents', 'none'],
        ['--debug', 'cli'],
        ['-u', 'none'],
      ]) {
        const fullResult = runCli(dir, ['test', '--', ...forwarded]);
        expect(fullResult.status, fullResult.stdout + fullResult.stderr).toBe(9);
      }
      await fs.rm(path.join(dir, 'test/unit'), { recursive: true });
      for (const command of [['test'], ['verify', '--full']]) {
        const noMatch = runCli(dir, [...command, '--grep', 'absent case']);
        expect(noMatch.status, noMatch.stdout + noMatch.stderr).toBe(0);
        expect(noMatch.stdout).toContain('Name filter "absent case" (empty suites allowed)');
      }
    }
  },
  120_000
);

it.each(
  [
    ['test', '--grep', ''],
    ['test', '--grep', '['],
    ['test', '--grep'],
    ['test', '--e2e', 'generate', '--grep', 'selected'],
    ['test', '--e2e', 'trace', '--grep', 'selected'],
    ['test', '--grep', 'selected', '--', '--grep', 'other'],
    ['test', '--grep', 'selected', '--', '-gother'],
    ['test', '--grep', 'selected', '--', '-tother'],
    ['verify', '--grep', 'selected'],
    ['verify', 'test/unit/selected.test.ts'],
    ['verify', '--full', 'test/unit/selected.test.ts', '--', '--grep', 'selected case$'],
    ['verify', '--full', '--', 'test/unit/selected.test.ts', '--grep', 'selected case$'],
    ['verify', '--', '--grep', 'selected case$'],
  ].map((args) => ({ args }))
)('rejects invalid selection $args before running anything', async ({ args }) => {
  const dir = await createFixture();
  const result = runCli(dir, args);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(await fs.exists(path.join(dir, 'executed'))).toBe(false);
  expect(await fs.exists(path.join(dir, '.wb'))).toBe(false);
});

it.each(['test', 'verify'])('explains non-string grep values for %s without running tests', async (command) => {
  const dir = await createFixture();
  for (const args of [['--no-grep'], ['--grep', 'first', '--grep', 'second']]) {
    const result = runCli(dir, [command, ...(command === 'verify' ? ['--full'] : []), ...args]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('--grep takes exactly one regular expression.');
    expect(await fs.exists(path.join(dir, 'executed'))).toBe(false);
    expect(await fs.exists(path.join(dir, '.wb'))).toBe(false);
  }
});

async function createFixture(): Promise<string> {
  await fs.mkdir('.tmp', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.tmp/test-selection-'));
  fixtures.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'selection-fixture', packageManager: 'bun@1.4.2' })
  );
  for (const suite of ['unit', 'e2e', 'debug']) {
    await fs.mkdir(path.join(dir, 'test', suite), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'test', suite, 'selected.test.ts'),
      `import { test } from 'bun:test';
import { appendFileSync } from 'node:fs';
test('selected case', () => { ${suite === 'debug' ? "throw new Error('Debug test ran');" : "appendFileSync('executed', 'selected');"} });
test('other case', () => { throw new Error('Unselected case ran'); });`
    );
    await fs.writeFile(
      path.join(dir, 'test', suite, 'other.test.ts'),
      "import { test } from 'bun:test'; test('other file', () => { throw new Error('Unselected file ran'); });"
    );
  }
  return dir;
}

function runCli(dir: string, args: string[]): SpawnSyncReturns<string> {
  const { BUN_TEST_WORKER_ID: _bunWorkerId, JEST_WORKER_ID: _jestWorkerId, ...env } = process.env;
  return spawnSync('node', [cliPath, ...args], { cwd: dir, encoding: 'utf8', env, timeout: 30_000 });
}
