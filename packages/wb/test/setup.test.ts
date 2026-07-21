import child_process from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { setup } from '../src/commands/setup.js';

import { initializeProjectDirectory, tempDir } from './shared.js';

describe('setup', () => {
  it(
    'app',
    async () => {
      const dirPath = path.join(tempDir, 'app');
      await initializeProjectDirectory(dirPath);
      child_process.spawnSync('bun install', {
        shell: true,
        stdio: 'inherit',
        cwd: dirPath,
      });

      await setup({}, dirPath);
      const ret = child_process.spawnSync(`bun run start test-on-ci -w ${dirPath}`, {
        shell: true,
        stdio: 'inherit',
      });
      expect(ret.status).toBe(0);
    },
    5 * 60 * 1000
  );
});
