import fs from 'node:fs';
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

  it(
    'reports a type error in a file that belongs to the workspace root',
    async () => {
      const dirPath = path.join(tempDir, 'monorepo');
      await initializeProjectDirectory(dirPath);
      await fs.promises.writeFile(
        path.join(dirPath, 'scripts', 'broken.ts'),
        'export const broken: number = "text";\n'
      );
      await spawnAsync('bun', ['install'], { stdio: 'inherit', cwd: dirPath });

      const ret = await spawnAsync('node', ['dist/index.js', 'typecheck', '-w', dirPath], {
        mergeOutAndError: true,
        stdio: 'pipe',
      });
      expect(ret.stdout).toContain('scripts/broken.ts');
      expect(ret.status).toBe(1);
    },
    5 * 60 * 1000
  );
});
