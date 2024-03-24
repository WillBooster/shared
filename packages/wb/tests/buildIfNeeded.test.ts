import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildIfNeeded } from '../src/commands/buildIfNeeded.js';

import { initializeProjectDirectory, tempDir } from './shared.js';

describe('buildIfNeeded', () => {
  it('app', async () => {
    const dirPath = path.join(tempDir, 'app');
    await initializeProjectDirectory(dirPath);

    child_process.execSync('git init', { cwd: dirPath, stdio: 'inherit' });
    child_process.execSync('git add -A', { cwd: dirPath, stdio: 'inherit' });
    child_process.execSync('git config user.email "bot@willbooster.com"', { cwd: dirPath, stdio: 'inherit' });
    child_process.execSync('git config user.name "WillBooster Inc."', { cwd: dirPath, stdio: 'inherit' });
    child_process.execSync('git add -A', { cwd: dirPath, stdio: 'inherit' });
    child_process.execSync('git commit -m .', { cwd: dirPath, stdio: 'inherit' });

    const command = 'echo build';
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);

    await fs.promises.writeFile(path.join(dirPath, 'index.js'), `console.log('Hello'); console.log('Hello');`);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);

    await fs.promises.writeFile(path.join(dirPath, 'README.md'), `# test-fixtures/app/`);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);

    await fs.promises.writeFile(
      path.join(dirPath, 'package.json'),
      JSON.stringify(
        {
          name: '@test-fixtures/app2',
        },
        undefined,
        2
      )
    );
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
  });
}, 30_000);
