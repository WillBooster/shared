import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildIfNeeded } from '../src/commands/buildIfNeeded.js';
import { project } from '../src/project.js';

import { tempDir } from './shared.js';

describe('buildIfNeeded', () => {
  it('app', async () => {
    project.dirPath = path.join(tempDir, 'app');
    await fs.promises.rm(project.dirPath, { recursive: true, force: true });
    await fs.promises.cp('test-fixtures/app', project.dirPath, { force: true, recursive: true });
    child_process.execSync('git init', { cwd: project.dirPath, stdio: 'inherit' });
    child_process.execSync('git add -A', { cwd: project.dirPath, stdio: 'inherit' });
    child_process.execSync('git config user.email "bot@willbooster.com"', { cwd: project.dirPath, stdio: 'inherit' });
    child_process.execSync('git config user.name "WillBooster Inc."', { cwd: project.dirPath, stdio: 'inherit' });
    child_process.execSync('git add -A', { cwd: project.dirPath, stdio: 'inherit' });
    child_process.execSync('git commit -m .', { cwd: project.dirPath, stdio: 'inherit' });

    const command = 'echo build';
    expect(await buildIfNeeded(command)).toBe(true);
    expect(await buildIfNeeded(command)).toBe(false);

    await fs.promises.writeFile(path.join(project.dirPath, 'index.js'), `console.log('Hello'); console.log('Hello');`);
    expect(await buildIfNeeded(command)).toBe(true);
    expect(await buildIfNeeded(command)).toBe(false);

    await fs.promises.writeFile(path.join(project.dirPath, 'README.md'), `# test-fixtures/app/`);
    expect(await buildIfNeeded(command)).toBe(false);

    await fs.promises.writeFile(
      path.join(project.dirPath, 'package.json'),
      JSON.stringify(
        {
          name: '@test-fixtures/app2',
        },
        undefined,
        2
      )
    );
    expect(await buildIfNeeded(command)).toBe(false);
  });
});
