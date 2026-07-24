import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, test } from 'vitest';

import {
  collectManifests,
  materializePrivatePackages,
  swapMaterializedTrees,
} from '../../src/commands/setupPrivatePackages.js';
import { findDescendantProjects } from '../../src/project.js';

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

  // The git and registry trees must commit as ONE transaction: a registry fetch failure used to
  // leave the already-swapped @willbooster tree next to a stale @willbooster-private tree, so a
  // registry manifest referencing file:../../@willbooster/<name> could dangle. The registry is made
  // unreachable via a reserved `.invalid` host, so the download always fails without a live server.
  it('leaves both materialized trees untouched when a registry download fails', async () => {
    const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-setup-private-'));
    try {
      await writeJson(path.join(rootDirPath, 'package.json'), {
        name: '@test/root',
        dependencies: {
          '@willbooster/needed': 'git@github.com:WillBooster/needed.git#main',
          '@willbooster-private/a': '1.0.0',
        },
      });
      await fs.writeFile(
        path.join(rootDirPath, '.npmrc'),
        '@willbooster-private:registry=http://wb-unreachable-registry.invalid\n'
      );
      // Installed only for the git dependency: the registry package has no installed copy, so it
      // must be downloaded — and that download fails.
      await writeJson(path.join(rootDirPath, 'node_modules', '@willbooster', 'needed', 'package.json'), {
        name: '@willbooster/needed',
        version: '1.0.0',
      });
      // Pre-existing linked materializations that must both survive the failure.
      const gitDirPath = path.join(rootDirPath, '@willbooster', 'needed');
      await writeJson(path.join(gitDirPath, 'package.json'), { name: '@willbooster/needed', version: '0.9.0' });
      const registryDirPath = path.join(rootDirPath, '@willbooster-private', 'a');
      await writeJson(path.join(registryDirPath, 'package.json'), {
        name: '@willbooster-private/a',
        version: '0.9.0',
        dependencies: { '@willbooster/needed': 'file:../../@willbooster/needed' },
      });

      const projects = await findDescendantProjects({}, false, rootDirPath);
      await expect(materializePrivatePackages(projects!.root.dirPath, collectManifests(projects!))).rejects.toThrow();

      expect(await readVersion(gitDirPath)).toBe('0.9.0');
      expect(await readVersion(registryDirPath)).toBe('0.9.0');
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

async function readVersion(packageDirPath: string): Promise<string | undefined> {
  const content = await fs.readFile(path.join(packageDirPath, 'package.json'), 'utf8');
  return (JSON.parse(content) as { version?: string }).version;
}

// The live tree is set aside BEFORE its replacement is renamed in, so a failure in that window
// leaves the previous materialization only in the backup. It must still be restored.
test('restores the tree whose staged replacement fails to move in', async () => {
  const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-swap-'));
  try {
    const firstOutDirPath = path.join(rootDirPath, '@willbooster');
    const secondOutDirPath = path.join(rootDirPath, '@willbooster-private');
    const stagingRootDirPath = path.join(rootDirPath, '.tmp', 'staging');
    const toStagedPath = (targetDirPath: string): string =>
      path.join(stagingRootDirPath, path.relative(rootDirPath, targetDirPath));

    // Both trees already materialized, and only the FIRST has a staged replacement — so the second
    // rename fails after its live tree has already been moved aside.
    for (const outDirPath of [firstOutDirPath, secondOutDirPath]) {
      await fs.mkdir(outDirPath, { recursive: true });
      await fs.writeFile(path.join(outDirPath, 'marker.txt'), 'previous');
    }
    await fs.mkdir(toStagedPath(firstOutDirPath), { recursive: true });
    await fs.writeFile(path.join(toStagedPath(firstOutDirPath), 'marker.txt'), 'staged');

    await expect(
      swapMaterializedTrees([firstOutDirPath, secondOutDirPath], toStagedPath, path.join(rootDirPath, '.tmp', 'backup'))
    ).rejects.toThrow();

    // Neither tree may be left replaced or missing.
    for (const outDirPath of [firstOutDirPath, secondOutDirPath]) {
      expect(await fs.readFile(path.join(outDirPath, 'marker.txt'), 'utf8')).toBe('previous');
    }
  } finally {
    await fs.rm(rootDirPath, { force: true, recursive: true });
  }
});
