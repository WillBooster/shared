import fs from 'node:fs';

import { describe, expect, it, afterAll, beforeAll } from 'vitest';

import { buildIfNeeded } from '../src/commands/buildIfNeeded.js';

describe('buildIfNeeded', () => {
  beforeAll(initializeFiles);

  it('app', async () => {
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(true);
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(false);

    await fs.promises.writeFile('test-fixtures/app/index.js', `console.log('Hello'); console.log('Hello');`);
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(true);
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(false);

    await fs.promises.writeFile('test-fixtures/app/README.md', `# test-fixtures/app/`);
    expect(await buildIfNeeded('yarn build', 'test-fixtures/app')).toBe(false);
  });

  afterAll(initializeFiles);
});

async function initializeFiles(): Promise<void> {
  await fs.promises.rm('test-fixtures/app/node_modules', { recursive: true, force: true });
  await fs.promises.writeFile('test-fixtures/app/index.js', `console.log('Hello');\n`);
  await fs.promises.writeFile('test-fixtures/app/README.md', `# test-fixtures/app\n`);
}
