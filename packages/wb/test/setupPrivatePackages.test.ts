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

  // A failed git-package copy (e.g. a dangling symlink in the installed source) must not leave a
  // half-populated @willbooster tree: git packages stage and swap in only after every copy
  // succeeds, so a previously materialized copy survives the failure.
  it('throws without destroying an existing materialization when a git-package copy fails', async () => {
    const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-setup-private-'));
    try {
      await writeJson(path.join(rootDirPath, 'package.json'), {
        name: '@test/root',
        dependencies: { '@willbooster/broken': 'git@github.com:WillBooster/broken.git#main' },
      });
      // The installed source contains a dangling symlink, so copying it (with dereference) fails.
      const installedDirPath = path.join(rootDirPath, 'node_modules', '@willbooster', 'broken');
      await writeJson(path.join(installedDirPath, 'package.json'), { name: '@willbooster/broken', version: '1.0.0' });
      await fs.symlink(path.join(installedDirPath, 'missing-target'), path.join(installedDirPath, 'dangling'));
      // A previously materialized copy that must survive the failed refresh.
      const materializedDirPath = path.join(rootDirPath, '@willbooster', 'broken');
      await writeJson(path.join(materializedDirPath, 'package.json'), {
        name: '@willbooster/broken',
        version: '0.9.0',
      });

      const projects = await findDescendantProjects({}, false, rootDirPath);
      await expect(materializePrivatePackages(projects!.root.dirPath, collectManifests(projects!))).rejects.toThrow();

      // The pre-existing materialization is untouched (staging never swapped in).
      expect(await readName(materializedDirPath)).toBe('@willbooster/broken');
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
