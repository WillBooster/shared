import fs from 'node:fs';

import { describe, expect, it, afterAll } from 'vitest';

import { buildIfNeeded } from '../src/commands/buildIfNeeded.js';

describe('buildIfNeeded', () => {
  it('app', async () => {
    await fs.promises.rm('test-fixtures/app/node_modules', { recursive: true, force: true });
    await fs.promises.writeFile('test-fixtures/app/index.js', `console.log('Hello');`);
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(true);
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(false);
    await fs.promises.writeFile('test-fixtures/app/index.js', `console.log('Hello'); console.log('Hello');`);
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(true);
  });

  afterAll(async () => {
    await fs.promises.writeFile('test-fixtures/app/index.js', `console.log('Hello');`);
  });
});
