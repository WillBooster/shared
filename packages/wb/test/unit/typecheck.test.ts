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
    'type-checks a monorepo without failing on root lint errors',
    async () => {
      const dirPath = path.join(tempDir, 'monorepo');
      await initializeProjectDirectory(dirPath);
      await fs.promises.writeFile(
        path.join(dirPath, 'oxlint.config.ts'),
        'export default { rules: { "no-console": "error" } };\n'
      );
      await fs.promises.writeFile(path.join(dirPath, 'scripts', 'lintError.ts'), 'console.log(1);\n');
      await spawnAsync('bun', ['install'], { stdio: 'inherit', cwd: dirPath });

      const ret = await spawnAsync('node', ['dist/index.js', 'typecheck', '-w', dirPath], { stdio: 'inherit' });
      expect(ret.status).toBe(0);
      const lint = await spawnAsync('node', ['dist/index.js', 'lint', '-w', dirPath], {
        mergeOutAndError: true,
        stdio: 'pipe',
      });
      expect(lint.status).toBe(1);
      expect(lint.stdout).toContain('no-console');
      expect(lint.stdout).toContain('scripts/lintError.ts');
    },
    5 * 60 * 1000
  );

  it(
    'reports a type error in a file that belongs to the workspace root',
    async () => {
      const dirPath = path.join(tempDir, 'root-type-error', 'monorepo');
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
