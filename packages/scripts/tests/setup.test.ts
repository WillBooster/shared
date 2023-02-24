import fs from 'node:fs';

import { describe, it } from 'vitest';

import { setup } from '../src/commands/setup.js';
import { test } from '../src/commands/test.js';
import { project } from '../src/project.js';

describe('setup', () => {
  it(
    'app',
    async () => {
      project.dirPath = 'temp/blitz';

      await fs.promises.rm('temp/blitz', { recursive: true, force: true });
      await fs.promises.cp('test-fixtures/blitz', 'temp/blitz', { force: true, recursive: true });
      await setup({ init: true });
      await test({ ci: true });
    },
    5 * 60 * 1000
  );
});
