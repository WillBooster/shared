import { fileURLToPath } from 'node:url';

import type { SpawnAsyncReturns } from '@willbooster/shared-lib-node/src';
import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { describe, expect, it } from 'bun:test';

const target = 'http://localhost:3000';
const cliPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

describe('wb open-cli', () => {
  it('lets automatic browser opening fail without failing the command', async () => {
    const result = await runOpenCli(['--optional', target]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(target);
    expect(result.stderr).toContain('Open it manually.');
  });

  it('reports a failure when opening was explicitly requested', async () => {
    const result = await runOpenCli([target]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/(?:open|xdg-open)/);
  });
});

async function runOpenCli(args: string[]): Promise<SpawnAsyncReturns> {
  const bunPath = Bun.which('bun');
  if (!bunPath) throw new Error('bun is required to run the wb CLI');

  return await spawnAsync(bunPath, [cliPath, 'open-cli', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: '/nonexistent' },
  });
}
