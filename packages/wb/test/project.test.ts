import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findDescendantProjects } from '../src/project.js';

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
});
