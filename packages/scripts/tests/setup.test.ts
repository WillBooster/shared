import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { setup } from '../src/commands/setup.js';
import { project } from '../src/project.js';

import { tempDir } from './shared.js';

describe('setup', () => {
  it(
    'app',
    async () => {
      project.dirPath = path.join(tempDir, 'blitz');
      await fs.promises.rm(project.dirPath, { recursive: true, force: true });
      await fs.promises.cp('test-fixtures/blitz', project.dirPath, { force: true, recursive: true });

      await setup({ init: true });
      const ret = child_process.spawnSync(`yarn start test -w ${project.dirPath} --ci`, {
        shell: true,
        stdio: 'inherit',
      });
      expect(ret.status).toBe(0);
    },
    5 * 60 * 1000
  );
});
