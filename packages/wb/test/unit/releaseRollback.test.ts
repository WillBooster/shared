import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { beforeAll, expect, test } from 'bun:test';

import { buildWb } from '../helpers/build.js';

const wbDirPath = fileURLToPath(new URL('../..', import.meta.url));
const semanticReleaseBinPath = createRequire(import.meta.url).resolve('semantic-release/bin/semantic-release.js');
const nodePath = Bun.which('node');
if (!nodePath) throw new Error('node must be on PATH.');
const timeout = 60_000;
const repository = 'WillBooster/release-test';

beforeAll(buildWb, 120_000);

// Serves GitHub's ref deletion by deleting the ref from the bare remote.
const fakeApi = `
import { execFileSync } from 'node:child_process';
globalThis.fetch = async (url, init = {}) => {
  const ref = url.replace('https://api.github.com/repos/${repository}/git/', '');
  if (init.method !== 'DELETE' || ref === url) throw new Error('Unexpected request: ' + init.method + ' ' + url);
  execFileSync('git', ['--git-dir', process.env.RELEASE_TEST_REMOTE, 'update-ref', '-d', ref]);
  return new Response(null, { status: 204 });
};
`;

// A publish plugin that fails when its `fail` option is set.
const publishPlugin = `
export function publish({ fail }) {
  if (fail) throw new Error('publish failed');
}
`;

interface Repo {
  run: (failingPublishes: boolean[]) => Promise<{ status: number | null; output: string; remoteRefs: string[] }>;
  dispose: () => void;
}

async function createRepo(): Promise<Repo> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-release-rollback-test-'));
  const repoDirPath = path.join(dirPath, 'repo');
  const remoteDirPath = path.join(dirPath, 'remote.git');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await spawnAsync('git', args, { cwd, env: gitEnv });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  fs.mkdirSync(path.join(repoDirPath, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(semanticReleaseBinPath, path.join(repoDirPath, 'node_modules', '.bin', 'semantic-release'));
  fs.writeFileSync(path.join(repoDirPath, 'package.json'), JSON.stringify({ name: 'release-test', private: true }));
  fs.writeFileSync(path.join(repoDirPath, 'publishPlugin.mjs'), publishPlugin);
  fs.writeFileSync(path.join(repoDirPath, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(dirPath, 'fakeApi.mjs'), fakeApi);
  await git(dirPath, 'init', '--quiet', '--bare', '--initial-branch=main', remoteDirPath);
  await git(repoDirPath, 'init', '--quiet', '--initial-branch=main');
  await git(repoDirPath, 'remote', 'add', 'origin', `file://${remoteDirPath}`);

  return {
    async run(failingPublishes) {
      fs.writeFileSync(
        path.join(repoDirPath, '.releaserc.json'),
        JSON.stringify({
          branches: ['main'],
          plugins: [
            '@semantic-release/commit-analyzer',
            ...failingPublishes.map((fail) => ['./publishPlugin.mjs', { fail }]),
          ],
        })
      );
      await git(repoDirPath, 'add', '.');
      await git(repoDirPath, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fix: test');
      await git(repoDirPath, 'push', '--quiet', 'origin', 'main');
      const result = await spawnAsync(nodePath as string, [path.join(wbDirPath, 'bin', 'index.js'), 'release'], {
        cwd: repoDirPath,
        env: {
          ...gitEnv,
          HOME: dirPath,
          CI: 'true',
          GITHUB_ACTIONS: '',
          GITHUB_EVENT_NAME: '',
          GITHUB_REF: '',
          GITHUB_REF_NAME: 'main',
          GITHUB_REPOSITORY: repository,
          GITHUB_TOKEN: 'fake',
          NODE_OPTIONS: `--import=${path.join(dirPath, 'fakeApi.mjs')}`,
          RELEASE_TEST_REMOTE: remoteDirPath,
        },
      });
      const refList = await git(remoteDirPath, 'for-each-ref', '--format=%(refname)', 'refs/tags', 'refs/notes');
      const remoteRefs = refList.split('\n').filter(Boolean);
      return { status: result.status, output: result.stdout + result.stderr, remoteRefs };
    },
    dispose: () => fs.rmSync(dirPath, { recursive: true, force: true }),
  };
}

test(
  'deletes the tag and note of a release whose publish failed, so that the next run releases the version',
  async () => {
    const repo = await createRepo();
    try {
      const failed = await repo.run([true]);
      expect(failed.status, failed.output).not.toBe(0);
      expect(failed.remoteRefs).toEqual([]);

      const retried = await repo.run([false]);
      expect(retried.status, retried.output).toBe(0);
      expect(retried.remoteRefs).toEqual(['refs/notes/semantic-release-v1.0.0', 'refs/tags/v1.0.0']);
    } finally {
      repo.dispose();
    }
  },
  timeout
);

test(
  'keeps the tag of a release that failed after a publish step completed',
  async () => {
    const repo = await createRepo();
    try {
      const failed = await repo.run([false, true]);
      expect(failed.status, failed.output).not.toBe(0);
      expect(failed.remoteRefs).toEqual(['refs/notes/semantic-release-v1.0.0', 'refs/tags/v1.0.0']);
      expect(failed.output).toContain('Complete the remaining publish steps manually.');
    } finally {
      repo.dispose();
    }
  },
  timeout
);
