import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  findDescendantProjects,
  findSelfProject,
  findWorkspacePackageDirs,
  getAbsoluteFileDatabaseUrlPath,
} from '../src/project.js';

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

  it('excludes the root manifest and node_modules from Yarn workspace discovery', async () => {
    const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wb-yarn-workspaces-'));
    try {
      for (const [relativePath, content] of [
        ['package.json', { name: 'root', workspaces: ['**'] }],
        ['packages/a/package.json', { name: 'a' }],
        ['node_modules/dep/package.json', { name: 'dep' }],
      ] as const) {
        await fs.promises.mkdir(path.join(dirPath, path.dirname(relativePath)), { recursive: true });
        await fs.promises.writeFile(path.join(dirPath, relativePath), JSON.stringify(content), 'utf8');
      }
      const packageJson = JSON.parse(await fs.promises.readFile(path.join(dirPath, 'package.json'), 'utf8')) as {
        workspaces: string[];
      };
      await expect(findWorkspacePackageDirs({ dirPath, packageJson, usesBunPackageManager: false })).resolves.toEqual([
        path.join(dirPath, 'packages', 'a'),
      ]);
    } finally {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    }
  });

  it('detects bun from a mise.toml tool pin', async () => {
    // wbfy migrates .tool-versions into mise.toml, so the tool-manifest signal must survive
    // for repos that gitignore bun.lock and have no packageManager field.
    const dirPath = path.join(tempDir, 'app');
    await initializeProjectDirectory(dirPath);
    await fs.promises.writeFile(path.join(dirPath, 'mise.toml'), '[tools]\nnode = "24.0.0"\nbun = "latest"\n');

    const project = findSelfProject({}, false, dirPath);
    expect(project?.isBunAvailable).toBe(true);
  });

  it('uses oxlint when declared', async () => {
    const dirPath = path.join(tempDir, 'app');
    await initializeProjectDirectory(dirPath);

    await fs.promises.writeFile(
      path.join(dirPath, 'package.json'),
      JSON.stringify(
        {
          name: '@test-fixtures/app',
          devDependencies: {
            oxlint: '1.60.0',
          },
        },
        undefined,
        2
      ) + '\n'
    );

    expect(findSelfProject({}, false, dirPath)?.preferredLinter).toBe('oxlint');
  });

  it('inherits oxlint from the workspace root', async () => {
    const dirPath = path.join(tempDir, 'monorepo');
    await initializeProjectDirectory(dirPath);

    await fs.promises.writeFile(
      path.join(dirPath, 'package.json'),
      JSON.stringify(
        {
          name: 'monorepo',
          workspaces: ['packages/*'],
          devDependencies: {
            oxlint: '1.60.0',
            typescript: '5.8.3',
          },
        },
        undefined,
        2
      ) + '\n'
    );

    expect(findSelfProject({}, false, path.join(dirPath, 'packages', 'sub1'))?.preferredLinter).toBe('oxlint');
  });

  it('resolves relative file DATABASE_URL values from the project directory', () => {
    const project = {
      dirPath: '/app/packages/server',
      env: { DATABASE_URL: 'file:../../drizzle/mount/prod.sqlite3' },
      rootDirPath: '/app',
    };

    expect(getAbsoluteFileDatabaseUrlPath(project)).toBe('/drizzle/mount/prod.sqlite3');
  });

  it('resolves root-relative file DATABASE_URL values from the repository root', () => {
    const project = {
      env: { DATABASE_URL: 'file:./drizzle/mount/prod.sqlite3' },
      rootDirPath: '/app',
    };

    expect(getAbsoluteFileDatabaseUrlPath(project)).toBe('/app/drizzle/mount/prod.sqlite3');
  });

  it.runIf(isMiseAvailable())(
    'lets mise env override an already-activated shell env for project commands',
    async () => {
      const dirPath = path.join('..', 'shared-lib-node', 'test', 'fixtures', 'app3');
      const originalPort = process.env.PORT;
      try {
        process.env.PORT = '9999';
        const project = findSelfProject({ cascadeEnv: 'test' }, true, dirPath);

        expect(project?.env.PORT).toBe('5002');
        expect(project?.env.MISE_ENV).toBe('test');
      } finally {
        if (originalPort === undefined) {
          delete process.env.PORT;
        } else {
          process.env.PORT = originalPort;
        }
      }
    }
  );
});

function isMiseAvailable(): boolean {
  return childProcess.spawnSync('mise', ['--version'], { stdio: 'ignore' }).status === 0;
}
