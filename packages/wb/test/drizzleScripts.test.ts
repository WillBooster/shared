import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getGenCodeScripts } from '../src/commands/genCode.js';
import { Project } from '../src/project.js';
import { drizzleScripts, findDrizzleConfig } from '../src/scripts/drizzleScripts.js';

describe('drizzle-kit commands', () => {
  it('runs drizzle-kit in the project directory when it has drizzle.config.*', async () => {
    const rootDirPath = await createMonorepo();
    const projectDirPath = path.join(rootDirPath, 'packages', 'server');
    await fs.writeFile(path.join(projectDirPath, 'drizzle.config.ts'), '');

    try {
      const project = new Project(projectDirPath, {}, false);
      expect(drizzleScripts.deploy(project)).toBe('YARN drizzle-kit migrate');
      expect(drizzleScripts.generate(project)).toBe('YARN drizzle-kit generate');
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });

  it('runs drizzle-kit in the monorepo root when only the root has drizzle.config.*', async () => {
    const rootDirPath = await createMonorepo();
    const projectDirPath = path.join(rootDirPath, 'packages', 'server');
    await fs.writeFile(path.join(rootDirPath, 'drizzle.config.ts'), '');

    try {
      const project = new Project(projectDirPath, {}, false);
      expect(drizzleScripts.deploy(project)).toBe(`(cd "${project.rootDirPath}" && YARN drizzle-kit migrate)`);
      expect(drizzleScripts.deploy(project, '--force')).toBe(
        `(cd "${project.rootDirPath}" && YARN drizzle-kit migrate --force)`
      );
      expect(findDrizzleConfig(project)).toEqual({
        dirPath: project.rootDirPath,
        fileName: 'drizzle.config.ts',
      });
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });

  it('falls back to the project directory when no drizzle.config.* exists', async () => {
    const rootDirPath = await createMonorepo();
    const projectDirPath = path.join(rootDirPath, 'packages', 'server');

    try {
      const project = new Project(projectDirPath, {}, false);
      expect(drizzleScripts.deploy(project)).toBe('YARN drizzle-kit migrate');
      expect(findDrizzleConfig(project)).toBeUndefined();
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });

  it('generates a drizzle-kit check script running in the monorepo root', async () => {
    const rootDirPath = await createMonorepo();
    const projectDirPath = path.join(rootDirPath, 'packages', 'server');
    await fs.writeFile(path.join(rootDirPath, 'drizzle.config.ts'), '');

    try {
      const project = new Project(projectDirPath, {}, false);
      expect(getGenCodeScripts(project)).toContain(
        `(cd "${project.rootDirPath}" && YARN drizzle-kit check --config drizzle.config.ts) || true`
      );
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });
});

async function createMonorepo(): Promise<string> {
  const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-drizzle-'));
  await fs.writeFile(
    path.join(rootDirPath, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] })
  );
  const projectDirPath = path.join(rootDirPath, 'packages', 'server');
  await fs.mkdir(projectDirPath, { recursive: true });
  await fs.writeFile(
    path.join(projectDirPath, 'package.json'),
    JSON.stringify({ name: 'server', dependencies: { 'drizzle-orm': '1.0.0' } })
  );
  return rootDirPath;
}
