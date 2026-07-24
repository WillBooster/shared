import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prependNodeModulesBinToPath } from '../../src/utils/binPath.js';

describe('prependNodeModulesBinToPath', () => {
  let rootDirPath: string;

  beforeEach(async () => {
    rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-bin-path-test-'));
  });

  afterEach(async () => {
    await fs.rm(rootDirPath, { force: true, recursive: true });
  });

  it('prepends every node_modules/.bin up to the repository root', async () => {
    // <root>/.git, <root>/node_modules/.bin, <root>/packages/app/node_modules/.bin
    await fs.mkdir(path.join(rootDirPath, '.git'), { recursive: true });
    await fs.mkdir(path.join(rootDirPath, 'node_modules', '.bin'), { recursive: true });
    const appDirPath = path.join(rootDirPath, 'packages', 'app');
    await fs.mkdir(path.join(appDirPath, 'node_modules', '.bin'), { recursive: true });

    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    expect(prependNodeModulesBinToPath(appDirPath, env)).toBe(true);
    // Nearest first: a workspace-local dependency must win over a repository-root one.
    expect(env.PATH).toBe(
      [path.join(appDirPath, 'node_modules', '.bin'), path.join(rootDirPath, 'node_modules', '.bin'), '/usr/bin'].join(
        ':'
      )
    );

    // The walk stops at the repository root (.git), so a .bin above it is not added.
    const env2: Record<string, string | undefined> = { PATH: '/usr/bin' };
    expect(prependNodeModulesBinToPath(path.join(rootDirPath, 'packages'), env2)).toBe(true);
    expect(env2.PATH).toBe(`${path.join(rootDirPath, 'node_modules', '.bin')}:/usr/bin`);
  });

  it('returns false and keeps PATH unchanged when no .bin directory exists', async () => {
    await fs.mkdir(path.join(rootDirPath, '.git'), { recursive: true });
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    expect(prependNodeModulesBinToPath(rootDirPath, env)).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('handles undefined or missing PATH in env correctly', async () => {
    await fs.mkdir(path.join(rootDirPath, '.git'), { recursive: true });
    await fs.mkdir(path.join(rootDirPath, 'node_modules', '.bin'), { recursive: true });

    const env: Record<string, string | undefined> = { PATH: undefined };
    expect(prependNodeModulesBinToPath(rootDirPath, env)).toBe(true);
    expect(env.PATH).toBe(path.join(rootDirPath, 'node_modules', '.bin'));

    const env2: Record<string, string | undefined> = {};
    expect(prependNodeModulesBinToPath(rootDirPath, env2)).toBe(true);
    expect(env2.PATH).toBe(path.join(rootDirPath, 'node_modules', '.bin'));
  });
});
