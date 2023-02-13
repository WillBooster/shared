import fs from 'node:fs';

import { describe, expect, it, afterAll, beforeAll } from 'vitest';

import { buildIfNeeded } from '../src/commands/buildIfNeeded.js';

describe('buildIfNeeded', () => {
  beforeAll(initializeFiles);

  it('app', async () => {
    const command = 'echo build';
    expect(await buildIfNeeded(command, 'test-fixtures/app')).toBe(true);
    expect(await buildIfNeeded(command, 'test-fixtures/app')).toBe(false);

    await fs.promises.writeFile('test-fixtures/app/index.js', `console.log('Hello'); console.log('Hello');`);
    expect(await buildIfNeeded(command, 'test-fixtures/app')).toBe(true);
    expect(await buildIfNeeded(command, 'test-fixtures/app')).toBe(false);

    await fs.promises.writeFile('test-fixtures/app/README.md', `# test-fixtures/app/`);
    expect(await buildIfNeeded(command, 'test-fixtures/app')).toBe(false);

    await fs.promises.writeFile(
      'test-fixtures/app/package.json',
      JSON.stringify(
        {
          name: '@test-fixtures/app2',
        },
        undefined,
        2
      )
    );
    expect(await buildIfNeeded(command, 'test-fixtures/app')).toBe(false);
  });

  afterAll(initializeFiles);
});

async function initializeFiles(): Promise<void> {
  await fs.promises.rm('test-fixtures/app/node_modules', { recursive: true, force: true });
  await fs.promises.writeFile('test-fixtures/app/index.js', `console.log('Hello');\n`);
  await fs.promises.writeFile('test-fixtures/app/README.md', `# test-fixtures/app\n`);
  await fs.promises.writeFile(
    'test-fixtures/app/package.json',
    JSON.stringify(
      {
        name: '@test-fixtures/app',
      },
      undefined,
      2
    ) + '\n'
  );
}
