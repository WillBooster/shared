import fs from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { afterEach, beforeAll, expect, it } from 'bun:test';

import { buildWb } from '../helpers/build.js';

const cliPath = path.resolve('bin/index.js');
const fixturePaths: string[] = [];
const committedViolation = 'warning: committed.ts:1-3 committed: function parameter count 8 (max 6)';
// Named to sort after the committed file, so that listing it first shows the reordering.
const addedViolation = 'warning: worktree.ts:1-3 worktree: function parameter count 8 (max 6)';

beforeAll(buildWb, 120_000);

afterEach(async () => {
  await Promise.all(fixturePaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it('prints every violation with its level and limits them to the changes with --base', async () => {
  const dir = await createFixture();
  const all = await runCli(dir, ['code-gauge']);
  expect(all.status, all.stdout + all.stderr).toBe(0);
  expect(stripVTControlCharacters(all.stdout)).toBe(
    `code-gauge: 0 errors, 2 warnings (2 functions, 0 files, 0 duplicated blocks)\n${committedViolation}\n${addedViolation}\n`
  );

  const changed = await runCli(dir, ['code-gauge', '--base', 'HEAD']);
  expect(changed.status, changed.stdout + changed.stderr).toBe(0);
  expect(changed.stdout).toContain(addedViolation);
  expect(changed.stdout).not.toContain(committedViolation);
}, 60_000);

it('shows the violations after the verification recap without failing', async () => {
  const dir = await createFixture();
  const result = await runCli(dir, ['verify']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const stdout = stripVTControlCharacters(result.stdout);
  expect(stdout).toMatch(/✔ code-gauge/);
  const header = 'code-gauge: 0 errors, 2 warnings (2 functions, 0 files, 0 duplicated blocks)';
  expect(stdout.indexOf('Verified in')).toBeLessThan(stdout.indexOf(header));
  expect(stdout).toContain(
    `${header}, 1 in code this branch changed (listed first)\n${addedViolation}\n${committedViolation}\n`
  );
  expect(stripVTControlCharacters(await fs.readFile(path.join(dir, '.wb/verify.log'), 'utf8'))).toContain(
    addedViolation
  );
}, 60_000);

it('lists a duplicated block the branch changed first although the two reports span it differently', async () => {
  // Two duplicated blocks of z.ts share a line, so the whole-project report merges them into 1-39
  // while the branch report, limited to the changed first line, holds only 1-20.
  const lines = Array.from(
    { length: 40 },
    (_, i) => `state.field${i} = process${i}(state.field${(i + 1) % 40}, ${i});`
  );
  const joined = (firstLine: string): string =>
    `${[firstLine, ...lines.slice(1, 20)].join('\n')} ${lines.slice(20).join('\n')}\n`;
  const dir = await createRepository({
    'a.ts': `${lines.slice(0, 20).join('\n')}\n`,
    'b.ts': `${lines.slice(20).join('\n')}\n`,
    'z.ts': joined(lines[0] as string),
  });
  await fs.writeFile(path.join(dir, 'z.ts'), joined(`${lines[0]} // comment`));

  const result = await runCli(dir, ['verify']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(stripVTControlCharacters(result.stdout)).toContain(
    '3 duplicated blocks), 1 in code this branch changed (listed first)\nwarning: z.ts:1-39: '
  );
}, 60_000);

it('lists a changed warning before an unchanged error and names the level of a milder limit', async () => {
  const dir = await createRepository({ 'committed.ts': deeplyNestedFunction('committed') });
  await fs.writeFile(path.join(dir, 'worktree.ts'), violatingFunction('worktree'));

  const result = await runCli(dir, ['verify']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(stripVTControlCharacters(result.stdout)).toContain(
    `code-gauge: 1 errors, 1 warnings (2 functions, 0 files, 0 duplicated blocks), 1 in code this branch changed (listed first)\n${addedViolation}\nerror: committed.ts:1-21 committed: function cognitive complexity 36 (max 30), function parameter count 7 (warning max 6)\n`
  );
}, 60_000);

/** A repository whose `origin/HEAD` commit has one violating function and whose working tree adds another. */
async function createFixture(): Promise<string> {
  const dir = await createRepository({ 'committed.ts': violatingFunction('committed') });
  await fs.writeFile(path.join(dir, 'worktree.ts'), violatingFunction('worktree'));
  return dir;
}

/** A git repository whose `origin/HEAD` commit holds the given files. */
async function createRepository(files: Record<string, string>): Promise<string> {
  const tmp = path.resolve('.tmp');
  await fs.mkdir(tmp, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmp, 'code-gauge-'));
  fixturePaths.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'code-gauge-fixture', packageManager: 'bun@1.4.2' })
  );
  await fs.writeFile(path.join(dir, '.gitignore'), '.wb/\n');
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
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
  return dir;
}

function violatingFunction(name: string): string {
  return `export function ${name}(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): number {
  return a + b + c + d + e + f + g + h;
}
`;
}

/** Cognitive complexity 36 exceeds the error limit, while 7 parameters exceed only the warning limit. */
function deeplyNestedFunction(name: string): string {
  const depth = 8;
  const opened = Array.from({ length: depth }, (_, i) => `${'  '.repeat(i + 1)}if (value > ${i}) {`);
  const closed = Array.from({ length: depth }, (_, i) => `${'  '.repeat(depth - i)}}`);
  return `export function ${name}(value: number, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0): number {
  let result = a + b + c + d + e + f;
${opened.join('\n')}
${'  '.repeat(depth + 1)}result = value;
${closed.join('\n')}
  return result;
}
`;
}

async function runCli(dir: string, args: string[]): ReturnType<typeof spawnAsync> {
  return await spawnAsync('node', [cliPath, ...args], { cwd: dir, timeout: 30_000 });
}
