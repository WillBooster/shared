import child_process from 'node:child_process';
import path from 'node:path';

import { removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import { describe, expect, it } from 'vitest';

import { setup } from '../src/commands/setup.js';

import { initializeProjectDirectory, tempDir } from './shared.js';

describe('setup', () => {
  it(
    'blitz',
    async () => {
      const dirPath = path.join(tempDir, 'blitz');
      await initializeProjectDirectory(dirPath);

      await setup({}, dirPath);
      expect(
        child_process.spawnSync(`yarn concurrently --version`, {
          env: removeNpmAndYarnEnvironmentVariables(process.env),
          shell: true,
          stdio: 'inherit',
        }).status
      ).toBe(0);
      const ret = child_process.spawnSync(`yarn start test -w ${dirPath} --ci`, {
        shell: true,
        stdio: 'inherit',
      });
      expect(ret.status).toBe(0);
    },
    5 * 60 * 1000
  );
});
