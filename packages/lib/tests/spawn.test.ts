import { describe, expect, it } from 'vitest';

import { spawnAsync } from '../src/spawn.js';

describe('spawn', () => {
  it.each([['ls'], ['ls -al']])('spawn "%s" successfully', async (commandWithArgs) => {
    const [command, ...args] = commandWithArgs.split(' ');
    const ret = await spawnAsync(command, args);
    expect(ret.pid).to.greaterThan(0);
    expect(ret.stdout).toBeTruthy();
    expect(ret.stderr).toBeFalsy();
    expect(ret.signal).toBeNull();
    expect(ret.status).toBe(0);
  });

  it.each([['ls -@']])('get non-zero code from "%s"', async (commandWithArgs) => {
    const [command, ...args] = commandWithArgs.split(' ');
    const ret = await spawnAsync(command, args);
    expect(ret.pid).to.greaterThan(0);
    expect(ret.stdout).toBeFalsy();
    expect(ret.stderr).toBeTruthy();
    expect(ret.signal).toBeNull();
    expect(ret.status).not.toBe(0);
  });

  it('failed to spawn "lll"', async () => {
    await expect(spawnAsync('lll')).rejects.toThrow();
  });
});
