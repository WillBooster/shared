import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findDescendantProjects, findSelfProject } from '../src/project.js';

import { initializeProjectDirectory, tempDir } from './shared.js';

describe('project', () => {
  it.each([
    { dirName: 'app', expected: 1 },
    { dirName: 'blitz', expected: 1 },
    { dirName: 'monorepo', expected: 3 },
    { dirName: 'unusual-monorepo', expected: 3 },
  ])(
    'findAllProjects $dirName',
    async ({ dirName, expected }) => {
      const dirPath = path.join(tempDir, dirName);
      await initializeProjectDirectory(dirPath);

      const projects = await findDescendantProjects({}, false, dirPath);
      expect(projects?.descendants.length).toBe(expected);
    },
    5 * 60 * 1000
  );

  it('prefers biome over eslint when both are declared', async () => {
    const dirPath = path.join(tempDir, 'app');
    await initializeProjectDirectory(dirPath);

    await fs.promises.writeFile(
      path.join(dirPath, 'package.json'),
      JSON.stringify(
        {
          name: '@test-fixtures/app',
          devDependencies: {
            '@biomejs/biome': '1.9.4',
            eslint: '9.39.2',
          },
        },
        undefined,
        2
      ) + '\n'
    );

    expect(findSelfProject({}, false, dirPath)?.preferredLinter).toBe('biome');
  });

  it('inherits eslint from the workspace root', async () => {
    const dirPath = path.join(tempDir, 'monorepo');
    await initializeProjectDirectory(dirPath);

    await fs.promises.writeFile(
      path.join(dirPath, 'package.json'),
      JSON.stringify(
        {
          name: 'monorepo',
          workspaces: ['packages/*'],
          devDependencies: {
            eslint: '9.39.2',
            typescript: '5.8.3',
          },
        },
        undefined,
        2
      ) + '\n'
    );

    expect(findSelfProject({}, false, path.join(dirPath, 'packages', 'sub1'))?.preferredLinter).toBe('eslint');
  });
});
