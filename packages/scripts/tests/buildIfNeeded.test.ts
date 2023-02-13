import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildIfNeeded } from '../src/commands/buildIfNeeded.js';

describe('buildIfNeeded', () => {
  it('app', async () => {
    await fs.promises.rm('test-fixtures/app/node_modules', { recursive: true, force: true });
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(true);
  });
});
