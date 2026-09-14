import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { afterEach, beforeAll, expect, it } from 'vitest';

const cliPath = path.resolve('bin/index.js');
const fixturePaths: string[] = [];

beforeAll(() => {
  const build = spawnSync('bun', ['run', 'build'], { encoding: 'utf8', timeout: 30_000 });
  expect(build.status, build.stdout + build.stderr).toBe(0);
});

afterEach(async () => {
  await Promise.all(fixturePaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it.each([false, true])('keeps successful output concise and saves raw output (full=%s)', async (full) => {
  const dir = await createFixture();
  const logPath = path.join(dir, '.wb', full ? 'verify-full.log' : 'verify.log');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, 'PREVIOUS_RUN');
  const result = runCli(dir, ['verify', ...(full ? ['--full'] : [])]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('Verified in');
  expect(result.stdout).toContain(logPath);
  expect(result.stdout).not.toContain('RAW_GENERATOR');
  expect(result.stdout).not.toContain('RAW_TEST');
  const log = await fs.readFile(logPath, 'utf8');
  expect(log).toContain('RAW_GENERATOR_STDOUT');
  expect(log).toContain('RAW_GENERATOR_STDERR');
  expect(log).not.toContain('PREVIOUS_RUN');
  expect(log).toContain('Verified in');
  expect(stripVTControlCharacters(log)).toMatch(/✔ typecheck/);
  if (full) expect(log).toContain('RAW_TEST_STDOUT');
  else expect(log).not.toContain('RAW_TEST_STDOUT');
});

it('fails full verification on slide text errors and saves their source locations', async () => {
  const dir = await createFixture();
  const deckPath = path.join(dir, 'intro.slidev.md');
  await fs.writeFile(deckPath, '# 検証\n\n- ﾃｽﾄ\n');
  const result = runCli(dir, ['verify', '--full']);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain('Failed step: slidev-check (exit code 1)');
  const log = await fs.readFile(path.join(dir, '.wb/verify-full.log'), 'utf8');
  expect(log).toContain(`${deckPath}:3:3:`);
  expect(log).toContain('(no-hankaku-kana)');
  expect(log).not.toContain('RAW_TEST_STDOUT');
});

it('shows the failed test step without earlier successful steps', async () => {
  const dir = await createFixture();
  await fs.writeFile(
    path.join(dir, 'test/unit/example.test.ts'),
    `import { test, expect } from 'bun:test';
test('failure', () => {
  console.log('FAILURE_STDOUT');
  console.error('FAILURE_STDERR');
  expect('actual').toBe('expected');
});`
  );
  const result = runCli(dir, ['verify', '--full']);
  expect(result.status).toBe(1);
  const log = await fs.readFile(path.join(dir, '.wb/verify-full.log'), 'utf8');
  for (const text of ['FAILURE_STDOUT', 'FAILURE_STDERR', 'expected', 'actual']) {
    expect(result.stdout + result.stderr).toContain(text);
    expect(log).toContain(text);
  }
  expect(result.stdout).not.toContain('Verified in');
  expect(result.stdout).toContain('Failed step: test (exit code 1)');
  expect(result.stdout).not.toContain('RAW_GENERATOR');
  expect(log).toContain('RAW_GENERATOR_STDOUT');
});

it.each(['bytes', 'lines'])('bounds failure output by %s and preserves the full log and exit code', async (limit) => {
  const dir = await createFixture();
  await fs.writeFile(
    path.join(dir, 'generate.ts'),
    `console.log(${JSON.stringify(limit === 'bytes' ? 'LARGE_MARKER'.repeat(20_000) : Array.from({ length: 200 }, (_, i) => `FAILURE_LINE_${i}`).join('\n'))});
console.error('LAST_FAILURE_MARKER');
process.exit(7);`
  );
  const result = runCli(dir, ['verify']);
  expect(result.status).toBe(7);
  expect(result.stdout).toContain('Failed step: gen-code (exit code 7)');
  expect(result.stdout).toContain('Output truncated');
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(17 * 1024);
  expect(result.stdout).toContain('LAST_FAILURE_MARKER');
  expect(result.stdout).toContain('Verification failed. Full log:');
  const log = await fs.readFile(path.join(dir, '.wb/verify.log'), 'utf8');
  if (limit === 'bytes') {
    expect(log.match(/LARGE_MARKER/g)).toHaveLength(20_000);
  } else {
    expect(log).toContain('FAILURE_LINE_0\n');
    expect(result.stdout).not.toContain('FAILURE_LINE_0\n');
    expect(result.stdout).toContain('FAILURE_LINE_199');
    expect(result.stdout.match(/FAILURE_LINE_/g)!.length).toBeLessThanOrEqual(100);
  }
});

it('saves raw output before completion, including when verification is killed', async () => {
  const dir = await createFixture();
  await fs.writeFile(
    path.join(dir, 'generate.ts'),
    `console.log('RAW_BEFORE_FINISH');
console.error('RAW_ERROR_BEFORE_FINISH');
while (!(await Bun.file('release').exists())) await Bun.sleep(10);`
  );
  const logPath = path.join(dir, '.wb/verify.log');
  const child = spawn('bun', [cliPath, 'verify'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  try {
    await expect
      .poll(() => fs.readFile(logPath, 'utf8').catch(() => ''), { timeout: 10_000 })
      .toContain('RAW_ERROR_BEFORE_FINISH');
    await expect.poll(() => output).toContain(`Full log: ${logPath}`);
    expect(output).not.toContain('RAW_BEFORE_FINISH');
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
    const log = await fs.readFile(logPath, 'utf8');
    expect(log).toContain('RAW_BEFORE_FINISH');
    expect(log).toContain('RAW_ERROR_BEFORE_FINISH');
    expect(log).not.toContain('Verified in');
  } finally {
    await fs.writeFile(path.join(dir, 'release'), '');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

it('preserves the previous log during dry-run and keeps standalone tests verbose', async () => {
  const dir = await createFixture();
  await fs.mkdir(path.join(dir, '.wb'));
  const logPath = path.join(dir, '.wb/verify-full.log');
  await fs.writeFile(logPath, 'PREVIOUS_RUN');
  const dryRun = runCli(dir, ['verify', '--full', '--dry-run']);
  expect(dryRun.status, dryRun.stderr).toBe(0);
  expect(dryRun.stdout).toContain('nothing was executed');
  expect(await fs.readFile(logPath, 'utf8')).toBe('PREVIOUS_RUN');
  const result = runCli(dir, ['test']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('RAW_TEST_STDOUT');
});

it.each([0, 7])('saves and flushes complete CI output with exit code %s', async (exitCode) => {
  const dir = await createFixture();
  const logPath = path.join(dir, '.wb/test-ci.log');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, 'PREVIOUS_RUN');
  const dryRun = runCli(dir, ['test-on-ci', '--dry-run']);
  expect(dryRun.status, dryRun.stderr).toBe(0);
  expect(await fs.readFile(logPath, 'utf8')).toBe('PREVIOUS_RUN');
  await fs.writeFile(
    path.join(dir, 'test/unit/example.test.ts'),
    `import fs from 'node:fs';
import { test } from 'bun:test';
test('large output', () => {
  fs.writeFileSync(1, 'CI_STDOUT_α😀\\n'.repeat(20_000));
  fs.writeFileSync(2, 'CI_STDERR_α😀\\n'.repeat(20_000));
  ${exitCode ? `process.exit(${exitCode});` : ''}
});`
  );
  const result = runCli(dir, ['test-on-ci']);
  expect(result.status, result.stderr).toBe(exitCode);
  const log = await fs.readFile(logPath, 'utf8');
  for (const output of [log, result.stdout + result.stderr]) {
    expect(output.match(/CI_STDOUT_α😀/g)).toHaveLength(20_000);
    expect(output.match(/CI_STDERR_α😀/g)).toHaveLength(20_000);
    expect(output).not.toContain('PREVIOUS_RUN');
  }
  expect(result.stdout).toContain(logPath);
});

it('preserves stdin EOF for CI E2E commands while capturing output', async () => {
  const dir = await createFixture();
  await fs.mkdir(path.join(dir, 'test/e2e'));
  await fs.writeFile(
    path.join(dir, 'test/e2e/input.test.ts'),
    `import fs from 'node:fs';
import { test, expect } from 'bun:test';
test('stdin', () => {
  expect(fs.readFileSync(0).length).toBe(0);
  console.log('E2E_STDIN_CLOSED');
});`
  );
  const result = runCli(dir, ['test-on-ci']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('E2E_STDIN_CLOSED');
  expect(await fs.readFile(path.join(dir, '.wb/test-ci.log'), 'utf8')).toContain('E2E_STDIN_CLOSED');
});

it('streams CI output larger than the wrapper heap without retaining it in memory', async () => {
  const dir = await createFixture();
  await fs.mkdir(path.join(dir, 'test/e2e'));
  await fs.writeFile(
    path.join(dir, 'test/e2e/large.test.ts'),
    `import fs from 'node:fs';
import { test } from 'bun:test';
test('large stream', () => {
  const chunk = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 160; i++) fs.writeFileSync(1, chunk);
});`
  );
  const result = spawnSync('node', ['--max-old-space-size=96', cliPath, 'test-on-ci'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const log = await fs.stat(path.join(dir, '.wb/test-ci.log'));
  expect(log.size).toBeGreaterThanOrEqual(160 * 1024 * 1024);
});

async function createFixture(): Promise<string> {
  const tmp = path.resolve('.tmp');
  await fs.mkdir(tmp, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmp, 'verify-output-'));
  fixturePaths.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'verify-output-fixture',
      packageManager: 'bun@1.4.2',
      scripts: { 'gen-code': 'bun generate.ts' },
    })
  );
  await fs.writeFile(
    path.join(dir, 'generate.ts'),
    "console.log('RAW_GENERATOR_STDOUT'); console.error('RAW_GENERATOR_STDERR');"
  );
  await fs.mkdir(path.join(dir, 'test/unit'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'test/unit/example.test.ts'),
    "import { test, expect } from 'bun:test'; test('example', () => { console.log('RAW_TEST_STDOUT'); expect(1).toBe(1); });"
  );
  return dir;
}

function runCli(dir: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('node', [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}
