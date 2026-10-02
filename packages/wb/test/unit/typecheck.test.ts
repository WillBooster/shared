import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { beforeAll, describe, expect, it } from 'bun:test';

import { buildWb } from '../helpers/build.js';
import { createTempDir, initializeProjectDirectory } from '../helpers/shared.js';

const tempDir = createTempDir();

beforeAll(buildWb, 120_000);

describe('typecheck', () => {
  it(
    'monorepo',
    async () => {
      const dirPath = path.join(tempDir, 'monorepo');
      await initializeProjectDirectory(dirPath);
      await spawnAsync('bun', ['install'], { stdio: 'inherit', cwd: dirPath });

      const ret = await spawnAsync('node', ['dist/index.js', 'typecheck', '-w', dirPath], { stdio: 'inherit' });
      console.log(ret);
      expect(ret.status).toBe(0);
    },
    5 * 60 * 1000
  );
});
