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
    if (playwright) {
      const unitFile = path.join(dir, 'test/unit/selected.test.ts');
      const unitSource = await fs.readFile(unitFile, 'utf8');
      await fs.writeFile(unitFile, unitSource.replace('selected case', 'unit selected case'));
      const unitResult = runCli(dir, ['test', '--grep', 'unit selected case$']);
      expect(unitResult.status, unitResult.stdout + unitResult.stderr).toBe(0);
      expect(await fs.readFile(path.join(dir, 'executed'), 'utf8')).toBe('selected');
      for (const file of ['selected.test.ts', 'other.test.ts']) {
        await fs.writeFile(
          path.join(dir, 'test/e2e', file),
          "import { test } from '@playwright/test'; test('passes', () => {});"
        );
      }
      const fullResult = runCli(dir, ['test', '--', '--workers=1']);
      expect(fullResult.status, fullResult.stdout + fullResult.stderr).toBe(9);
    }
  },
  120_000
);

it.each(
  [
    ['test', '--grep', ''],
    ['test', '--grep', '['],
    ['test', '--grep'],
    ['test', '--grep', 'selected', '--', '--grep', 'other'],
    ['test', '--grep', 'selected', '--', '-gother'],
    ['test', '--grep', 'selected', '--', '-tother'],
    ['verify', '--grep', 'selected'],
    ['verify', 'test/unit/selected.test.ts'],
  ].map((args) => ({ args }))
)('rejects invalid selection $args before running anything', async ({ args }) => {
  const dir = await createFixture();
  const result = runCli(dir, args);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(await fs.exists(path.join(dir, 'executed'))).toBe(false);
  expect(await fs.exists(path.join(dir, '.wb'))).toBe(false);
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
  return spawnSync('node', [cliPath, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}
