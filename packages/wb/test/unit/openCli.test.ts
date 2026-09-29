import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';

const target = 'http://localhost:3000';
const cliPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

describe('wb open-cli', () => {
  it('lets automatic browser opening fail without failing the command', () => {
    const result = runOpenCli(['--optional', target]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(target);
    expect(result.stderr).toContain('Open it manually.');
  });

  it('reports a failure when opening was explicitly requested', () => {
    const result = runOpenCli([target]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/(?:open|xdg-open)/);
  });
});

function runOpenCli(args: string[]): childProcess.SpawnSyncReturns<string> {
  const bunPath = Bun.which('bun');
  if (!bunPath) throw new Error('bun is required to run the wb CLI');

  return childProcess.spawnSync(bunPath, [cliPath, 'open-cli', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent' },
  });
}
