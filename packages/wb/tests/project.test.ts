import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findAllProjects } from '../src/project.js';

import { initializeProjectDirectory, tempDir } from './shared.js';

describe('project', () => {
  it.each(['app', 'blitz'])(
    'findAllProjects %s',
    async (dirName) => {
      const dirPath = path.join(tempDir, dirName);
      await initializeProjectDirectory(dirPath);

      const projects = await findAllProjects({}, false, dirPath);
      expect(projects?.all.length).toBe(1);
    },
    5 * 60 * 1000
  );
});
