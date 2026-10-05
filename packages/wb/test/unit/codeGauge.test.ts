import fs from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { afterEach, beforeAll, expect, it } from 'bun:test';

import { buildWb } from '../helpers/build.js';

const cliPath = path.resolve('bin/index.js');
const fixturePaths: string[] = [];
const committedViolation = 'committed.ts:1-3 committed: function parameter count 8 (<= 7)';
const addedViolation = 'added.ts:1-3 added: function parameter count 8 (<= 7)';

beforeAll(buildWb, 120_000);

afterEach(async () => {
  await Promise.all(fixturePaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it('prints every violation as a warning and limits them to the changes with --base', async () => {
  const dir = await createFixture();
  const all = await runCli(dir, ['code-gauge']);
  expect(all.status, all.stdout + all.stderr).toBe(0);
  expect(stripVTControlCharacters(all.stdout)).toBe(
    `code-gauge: 2 threshold violations (2 functions, 0 files, 0 duplicated blocks)\n${addedViolation}\n${committedViolation}\n`
  );

  const changed = await runCli(dir, ['code-gauge', '--base', 'HEAD']);
  expect(changed.status, changed.stdout + changed.stderr).toBe(0);
  expect(changed.stdout).toContain(addedViolation);
  expect(changed.stdout).not.toContain(committedViolation);
}, 60_000);

it('shows the warnings after the verification recap without failing', async () => {
  const dir = await createFixture();
  const result = await runCli(dir, ['verify']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const stdout = stripVTControlCharacters(result.stdout);
  expect(stdout).toMatch(/✔ code-gauge/);
  const header = 'code-gauge: 2 threshold violations (2 functions, 0 files, 0 duplicated blocks)';
  expect(stdout.indexOf('Verified in')).toBeLessThan(stdout.indexOf(header));
  expect(stdout).toContain(`${header}, the first one in code this branch changed\n${addedViolation}\n`);
  expect(stdout).toContain(committedViolation);
  expect(stripVTControlCharacters(await fs.readFile(path.join(dir, '.wb/verify.log'), 'utf8'))).toContain(
    addedViolation
  );
}, 60_000);

/** A repository whose `origin/HEAD` commit has one violating function and whose working tree adds another. */
async function createFixture(): Promise<string> {
  const tmp = path.resolve('.tmp');
  await fs.mkdir(tmp, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmp, 'code-gauge-'));
  fixturePaths.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'code-gauge-fixture', packageManager: 'bun@1.4.2' })
  );
  await fs.writeFile(path.join(dir, '.gitignore'), '.wb/\n');
  await fs.writeFile(path.join(dir, 'committed.ts'), violatingFunction('committed'));
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init',
    ],
    ['update-ref', 'refs/remotes/origin/HEAD', 'HEAD'],
  ]) {
    const git = await spawnAsync('git', args, { cwd: dir });
    expect(git.status, git.stderr).toBe(0);
  }
  await fs.writeFile(path.join(dir, 'added.ts'), violatingFunction('added'));
  return dir;
}

function violatingFunction(name: string): string {
  return `export function ${name}(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): number {
  return a + b + c + d + e + f + g + h;
}
`;
}

async function runCli(dir: string, args: string[]): ReturnType<typeof spawnAsync> {
  return await spawnAsync('node', [cliPath, ...args], { cwd: dir, timeout: 30_000 });
}
