import path from 'node:path';

import { expect, test } from 'vitest';

import { getYarnrcPrettierArgs } from '../src/generators/yarnrc.js';

test('formats .yarnrc.yml without loading target prettier config', () => {
  const dirPath = path.resolve('/tmp/project');
  const yarnrcYmlPath = path.join(dirPath, '.yarnrc.yml');

  expect(getYarnrcPrettierArgs(dirPath, yarnrcYmlPath)).toEqual([
    'dlx',
    'prettier',
    '--no-config',
    '--write',
    '.yarnrc.yml',
  ]);
});
