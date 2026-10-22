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

// Stands for npm: \`npm publish\` fails, and \`npm view\` reports the version held when RELEASE_TEST_NPM_HOLDS is set.
const fakeNpm = `#!/bin/sh
case "$1" in
  publish) exit 1 ;;
  view) if [ -n "$RELEASE_TEST_NPM_HOLDS" ]; then echo 1.0.0; else echo 'npm error code E404' >&2; exit 1; fi ;;
esac
`;

const npmPlugin = ['@semantic-release/npm', { pkgRoot: 'pkg' }];

interface RunResult {
  status: number | null;
  output: string;
  remoteRefs: string[];
}

interface Repo {
  run: (plugins: unknown[], env?: Record<string, string>) => Promise<RunResult>;
  /** Makes the remote reject pushes of semantic-release notes, which fail a release after its tag push. */
  rejectNotePushes: (reject: boolean) => void;
  dispose: () => void;
}

async function createRepo(): Promise<Repo> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-release-rollback-test-'));
  const repoDirPath = path.join(dirPath, 'repo');
  const remoteDirPath = path.join(dirPath, 'remote.git');
  const binDirPath = path.join(dirPath, 'bin');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await spawnAsync('git', args, { cwd, env: gitEnv });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  fs.mkdirSync(path.join(repoDirPath, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(semanticReleaseBinPath, path.join(repoDirPath, 'node_modules', '.bin', 'semantic-release'));
  fs.writeFileSync(path.join(repoDirPath, 'package.json'), JSON.stringify({ name: 'release-test', private: true }));
  fs.mkdirSync(path.join(repoDirPath, 'pkg'));
  fs.writeFileSync(path.join(repoDirPath, 'pkg', 'package.json'), JSON.stringify({ name: 'release-test-pkg' }));
  fs.writeFileSync(path.join(repoDirPath, 'publishPlugin.mjs'), publishPlugin);
  fs.writeFileSync(path.join(repoDirPath, '.gitignore'), 'node_modules\n');
  // wb removes NPM_* variables, so @semantic-release/npm authenticates from .npmrc as on CI.
  fs.writeFileSync(path.join(repoDirPath, '.npmrc'), '//registry.npmjs.org/:_authToken=fake\n');
  fs.writeFileSync(path.join(dirPath, 'fakeApi.mjs'), fakeApi);
  fs.mkdirSync(binDirPath);
  fs.writeFileSync(path.join(binDirPath, 'npm'), fakeNpm, { mode: 0o755 });
  await git(dirPath, 'init', '--quiet', '--bare', '--initial-branch=main', remoteDirPath);
  await git(repoDirPath, 'init', '--quiet', '--initial-branch=main');
  await git(repoDirPath, 'remote', 'add', 'origin', `file://${remoteDirPath}`);

  return {
    async run(plugins, env = {}) {
      fs.writeFileSync(
        path.join(repoDirPath, '.releaserc.json'),
        JSON.stringify({ branches: ['main'], plugins: ['@semantic-release/commit-analyzer', ...plugins] })
      );
      await git(repoDirPath, 'add', '.');
      await git(
        repoDirPath,
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'fix: test'
      );
      await git(repoDirPath, 'push', '--quiet', 'origin', 'main');
      const result = await spawnAsync(nodePath as string, [path.join(wbDirPath, 'bin', 'index.js'), 'release'], {
        cwd: repoDirPath,
        env: {
          ...gitEnv,
          ...env,
          PATH: `${binDirPath}${path.delimiter}${process.env.PATH}`,
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
    rejectNotePushes(reject) {
      const hookPath = path.join(remoteDirPath, 'hooks', 'pre-receive');
      if (reject) fs.writeFileSync(hookPath, '#!/bin/sh\n! grep -q refs/notes/\n', { mode: 0o755 });
      else fs.rmSync(hookPath, { force: true });
    },
    dispose: () => fs.rmSync(dirPath, { recursive: true, force: true }),
  };
}

const releasedRefs = ['refs/notes/semantic-release-v1.0.0', 'refs/tags/v1.0.0'];

async function withRepo(callback: (repo: Repo) => Promise<void>): Promise<void> {
  const repo = await createRepo();
  try {
    await callback(repo);
  } finally {
    repo.dispose();
  }
}

test(
  'deletes the tag of a release that failed before publishing, so that the next run releases it',
  () =>
    withRepo(async (repo) => {
      repo.rejectNotePushes(true);
      const failed = await repo.run([['./publishPlugin.mjs', { fail: false }]]);
      expect(failed.status, failed.output).not.toBe(0);
      expect(failed.remoteRefs, failed.output).toEqual([]);

      repo.rejectNotePushes(false);
      const retried = await repo.run([['./publishPlugin.mjs', { fail: false }]]);
      expect(retried.status, retried.output).toBe(0);
      expect(retried.remoteRefs).toEqual(releasedRefs);
    }),
  timeout
);

test(
  'deletes the tag of a release whose npm publish failed when npm lacks the version',
  () =>
    withRepo(async (repo) => {
      const failed = await repo.run([npmPlugin]);
      expect(failed.status, failed.output).not.toBe(0);
      expect(failed.output).toContain('Start step "publish" of plugin "@semantic-release/npm"');
      expect(failed.remoteRefs, failed.output).toEqual([]);
    }),
  timeout
);

test.each([
  ['npm holds the version', [npmPlugin], { RELEASE_TEST_NPM_HOLDS: '1' }],
  ['another publish plugin started', [['./publishPlugin.mjs', { fail: true }]], {}],
  [
    'a publish step completed',
    [
      ['./publishPlugin.mjs', { fail: false }],
      ['./publishPlugin.mjs', { fail: true }],
    ],
    {},
  ],
] as const)(
  'keeps the tag of a failed release when %s',
  (_case, plugins, env) =>
    withRepo(async (repo) => {
      const failed = await repo.run([...plugins], env);
      expect(failed.status, failed.output).not.toBe(0);
      expect(failed.remoteRefs, failed.output).toEqual(releasedRefs);
      expect(failed.output).toContain('so the tag is kept');
    }),
  timeout
);
