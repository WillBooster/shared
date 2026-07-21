import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectManifests, materializePrivatePackages } from '../src/commands/setupPrivatePackages.js';
import { findDescendantProjects } from '../src/project.js';

describe('materializePrivatePackages', () => {
  // A private dependency may be declared in a workspace package (e.g. packages/server) rather than
  // the repository root; both must be materialized at the root so `wb optimizeForDockerBuild`
  // resolves them uniformly. Uses git-URL dependencies so materialization copies from an installed
  // node_modules copy and never touches the registry.
  it('materializes private dependencies declared in the root and in workspace packages', async () => {
    const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-setup-private-'));
    try {
      await writeJson(path.join(rootDirPath, 'package.json'), {
        name: '@test/root',
        workspaces: ['packages/*'],
        dependencies: { '@willbooster/root-dep': 'git@github.com:WillBooster/root-dep.git#main' },
      });
      await writeJson(path.join(rootDirPath, 'packages', 'server', 'package.json'), {
        name: '@test/server',
        dependencies: { '@willbooster/server-dep': 'git@github.com:WillBooster/server-dep.git#main' },
      });
      await writeJson(path.join(rootDirPath, 'node_modules', '@willbooster', 'root-dep', 'package.json'), {
        name: '@willbooster/root-dep',
        version: '1.0.0',
      });
      await writeJson(path.join(rootDirPath, 'node_modules', '@willbooster', 'server-dep', 'package.json'), {
        name: '@willbooster/server-dep',
        version: '1.0.0',
      });

      const projects = await findDescendantProjects({}, false, rootDirPath);
      expect(projects).toBeDefined();
      await materializePrivatePackages(projects!.root.dirPath, collectManifests(projects!));

      expect(await readName(path.join(rootDirPath, '@willbooster', 'root-dep'))).toBe('@willbooster/root-dep');
      expect(await readName(path.join(rootDirPath, '@willbooster', 'server-dep'))).toBe('@willbooster/server-dep');
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

async function readName(packageDirPath: string): Promise<string | undefined> {
  const content = await fs.readFile(path.join(packageDirPath, 'package.json'), 'utf8');
  return (JSON.parse(content) as { name?: string }).name;
}
