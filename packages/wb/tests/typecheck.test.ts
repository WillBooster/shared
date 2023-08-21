import child_process from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { project } from '../src/project.js';

import { initializeProjectDirectory, tempDir } from './shared.js';

describe('typecheck', () => {
  it(
    'monorepo',
    async () => {
      project.dirPath = path.join(tempDir, 'monorepo');
      await initializeProjectDirectory();

      child_process.spawnSync('yarn', {
        shell: true,
        stdio: 'inherit',
        cwd: project.dirPath,
        // CI blocks 'yarn install'
        env: { ...process.env, CI: '' },
      });
      child_process.spawnSync('yarn build', {
        shell: true,
        stdio: 'inherit',
      });
      const ret = child_process.spawnSync(`node dist/index.js typecheck -w ${project.dirPath}`, {
        shell: true,
        stdio: 'inherit',
      });
      expect(ret.status).toBe(0);
    },
    5 * 60 * 1000
  );
});
