import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findAllProjects } from '../src/project.js';

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

      const projects = await findAllProjects({}, false, dirPath);
      expect(projects?.all.length).toBe(expected);
    },
    5 * 60 * 1000
  );
});
