import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Project } from '../../../src/project.js';
import { dockerScripts } from '../../../src/scripts/dockerScripts.js';

describe.runIf(isDockerAvailable())('dockerScripts', () => {
  it('removes a non-running container before reuse', async () => {
    const projectDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-docker-scripts-'));
    const containerName = `wb-cleanup-test-${randomUUID()}`;
    await fs.writeFile(path.join(projectDirPath, 'package.json'), `${JSON.stringify({ name: containerName })}\n`);
    await fs.writeFile(path.join(projectDirPath, 'Dockerfile'), 'FROM scratch\nCMD ["/bin/true"]\n');
    const project = new Project(projectDirPath, {}, false);

    try {
      runDocker(['build', '--quiet', '--tag', containerName, projectDirPath]);
      runDocker(['create', '--name', containerName, containerName]);
      expect(inspectContainerStatus(containerName)).toBe('created');

      const result = childProcess.spawnSync(dockerScripts.stop(project), {
        cwd: projectDirPath,
        encoding: 'utf8',
        shell: true,
      });

      expect(result.status).toBe(0);
      expect(containerExists(containerName)).toBe(false);
    } finally {
      childProcess.spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
      childProcess.spawnSync('docker', ['image', 'rm', '--force', containerName], { stdio: 'ignore' });
      await fs.rm(projectDirPath, { force: true, recursive: true });
    }
  }, 30_000);
});

function isDockerAvailable(): boolean {
  return childProcess.spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

function runDocker(args: string[]): void {
  const result = childProcess.spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `docker ${args.join(' ')} failed`);
  }
}

function inspectContainerStatus(containerName: string): string {
  return childProcess
    .execFileSync('docker', ['container', 'inspect', '--format', '{{.State.Status}}', containerName], {
      encoding: 'utf8',
    })
    .trim();
}

function containerExists(containerName: string): boolean {
  return childProcess.spawnSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' }).status === 0;
}
