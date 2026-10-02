import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { describe, expect, it } from 'bun:test';

import { Project } from '../../../src/project.js';
import { dockerScripts, selectContainerEnvKeys } from '../../../src/scripts/dockerScripts.js';

describe('selectContainerEnvKeys', () => {
  it('forwards the declared variables but never the ones the image owns', () => {
    const keys = selectContainerEnvKeys(new Set(['DATABASE_URL', 'NODE_ENV', 'PORT', 'APP_ORIGIN', 'UNRESOLVED']), {
      APP_ORIGIN: 'https://example.com',
      DATABASE_URL: 'file:./test.sqlite3',
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      PORT: '3000',
    });
    expect(keys).toEqual(['APP_ORIGIN', 'DATABASE_URL']);
  });
});

describe.if(await isDockerAvailable())('dockerScripts', () => {
  it('removes a non-running container before reuse', async () => {
    const projectDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-docker-scripts-'));
    const containerName = `wb-cleanup-test-${randomUUID()}`;
    await fs.writeFile(path.join(projectDirPath, 'package.json'), `${JSON.stringify({ name: containerName })}\n`);
    await fs.writeFile(path.join(projectDirPath, 'Dockerfile'), 'FROM scratch\nCMD ["/bin/true"]\n');
    const project = new Project(projectDirPath, {}, false);

    try {
      await runDocker(['build', '--quiet', '--tag', containerName, projectDirPath]);
      await runDocker(['create', '--name', containerName, containerName]);
      const status = await runDocker(['container', 'inspect', '--format', '{{.State.Status}}', containerName]);
      expect(status.trim()).toBe('created');

      const result = await spawnAsync(dockerScripts.stop(project), [], { cwd: projectDirPath, shell: true });

      expect(result.status).toBe(0);
      expect(await containerExists(containerName)).toBe(false);
    } finally {
      await spawnAsync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
      await spawnAsync('docker', ['image', 'rm', '--force', containerName], { stdio: 'ignore' });
      await fs.rm(projectDirPath, { force: true, recursive: true });
    }
  }, 30_000);
});

async function isDockerAvailable(): Promise<boolean> {
  if (!Bun.which('docker')) return false;
  const result = await spawnAsync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
  return result.status === 0;
}

async function runDocker(args: string[]): Promise<string> {
  const result = await spawnAsync('docker', args);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `docker ${args.join(' ')} failed`);
  }
  return result.stdout;
}

async function containerExists(containerName: string): Promise<boolean> {
  const result = await spawnAsync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
  return result.status === 0;
}
