import child_process from 'node:child_process';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'bun:test';

import { buildWb } from '../helpers/build.js';
import { initializeProjectDirectory, tempDir } from '../helpers/shared.js';

beforeAll(buildWb, 120_000);

describe('typecheck', () => {
  it(
    'monorepo',
    async () => {
      const dirPath = path.join(tempDir, 'monorepo');
      await initializeProjectDirectory(dirPath);
      child_process.spawnSync('bun install', {
        shell: true,
        stdio: 'inherit',
        cwd: dirPath,
      });

      const ret = child_process.spawnSync(`node dist/index.js typecheck -w ${dirPath}`, {
        shell: true,
        stdio: 'inherit',
      });
      console.log(ret);
      expect(ret.status).toBe(0);
    },
    5 * 60 * 1000
  );
});
