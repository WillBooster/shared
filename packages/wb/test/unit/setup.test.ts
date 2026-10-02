import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { describe, expect, it } from 'bun:test';

import { setup } from '../../src/commands/setup.js';

import { createTempDir, initializeProjectDirectory } from '../helpers/shared.js';

const tempDir = createTempDir();

describe('setup', () => {
  it(
    'app',
    async () => {
      const dirPath = path.join(tempDir, 'app');
      await initializeProjectDirectory(dirPath);
      await spawnAsync('bun', ['install'], { stdio: 'inherit', cwd: dirPath });

      await setup({}, dirPath);
      const ret = await spawnAsync('bun', ['run', 'start', 'test-on-ci', '-w', dirPath], { stdio: 'inherit' });
      expect(ret.status).toBe(0);
    },
    5 * 60 * 1000
  );
});
