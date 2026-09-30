import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, expect, test } from 'bun:test';

import { buildWb } from '../helpers/build.js';

const wbDirPath = fileURLToPath(new URL('../..', import.meta.url));
const semanticReleaseBinPath = createRequire(import.meta.url).resolve('semantic-release/bin/semantic-release.js');
// The released CLI runs under node (bin/index.js's shebang), not the bun test runner's runtime.
const nodePath = Bun.which('node');
if (!nodePath) throw new Error('node must be on PATH.');
// Every case creates git repositories and runs wb (and semantic-release) in child processes, which takes seconds on
// a loaded machine.
const timeout = 60_000;
const repository = 'WillBooster/release-test';
// A draft target standing for the commit of the repository a run releases from.
const headCommit = 'HEAD';
const olderCommit = 'a'.repeat(40);
const pendingMarker = '\n\n<!-- pending release -->';
const oidcUrl = 'https://actions.example/token?api-version=2.0';

beforeAll(buildWb, 120_000);

// Serves GitHub, the registries, and the GitHub Actions OIDC token from the JSON file RELEASE_TEST_STATE, which every
// process of a run (wb and semantic-release) shares, and appends every request to RELEASE_TEST_LOG. The first request
// matching each of the state's `failures` (a method and part of the URL) fails in the given way.
const fakeApi = `
import fs from 'node:fs';
const statePath = process.env.RELEASE_TEST_STATE;
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  const body = init.body === undefined ? undefined : JSON.parse(init.body);
  fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify({ tool: 'fetch', method, url, body }) + '\\n');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const key = Object.keys(state.failures).find((key) => key.startsWith(method + ' ') && url.includes(key.split(' ')[1]));
  const failure = state.failures[key];
  delete state.failures[key];
  let response;
  if (failure === 'drop') response = new TypeError('fetch failed');
  else if (failure === 'rateLimit') response = new Response('', { status: 429, headers: { 'retry-after': '1' } });
  else if (failure === 'serverError') response = new Response('', { status: 502 });
  else if (failure === 'validationError') response = Response.json({ message: 'Validation Failed' }, { status: 422 });
  else response = respond(state, method, url, body);
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (failure === 'dropAfterProcessing' || response instanceof TypeError) throw new TypeError('fetch failed');
  return response;
};
function respond(state, method, url, body) {
  const route = url.replace('https://api.github.com/repos/${repository}/', '');
  if (route === 'releases?per_page=100') return Response.json(state.releases);
  if (method === 'POST' && route === 'releases') {
    const release = { ...body, id: state.releases.length + 1, html_url: 'https://github.com/release' };
    state.releases.unshift(release);
    return Response.json(release, { status: 201 });
  }
  const releaseId = Number(/^releases\\/(\\d+)$/.exec(route)?.[1]);
  const releaseIndex = state.releases.findIndex((release) => release.id === releaseId);
  if (method === 'PATCH' && releaseIndex >= 0) {
    Object.assign(state.releases[releaseIndex], body);
    return Response.json(state.releases[releaseIndex]);
  }
  if (method === 'DELETE' && releaseId) {
    if (releaseIndex < 0) return new Response('', { status: 404 });
    state.releases.splice(releaseIndex, 1);
    return new Response(null, { status: 204 });
  }
  if (method === 'POST' && route === 'git/refs') {
    if (state.refs[body.ref]) return Response.json({ message: 'Reference already exists' }, { status: 422 });
    state.refs[body.ref] = body.sha;
    return Response.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 });
  }
  if (method === 'GET' && route.startsWith('git/ref/')) {
    const sha = state.refs['refs/' + route.slice('git/ref/'.length)];
    return sha ? Response.json({ object: { sha } }) : Response.json({ message: 'Not Found' }, { status: 404 });
  }
  if (method === 'DELETE' && route.startsWith('git/refs/')) {
    const ref = 'refs/' + route.slice('git/refs/'.length);
    if (!state.refs[ref]) return Response.json({ message: 'Reference does not exist' }, { status: 422 });
    delete state.refs[ref];
    return new Response(null, { status: 204 });
  }
  if (method === 'POST' && route === 'actions/workflows/release.yml/dispatches') return new Response(null, { status: 204 });
  if (url.startsWith('https://registry.npmjs.org/')) {
    const commit = state.npmCommits[url.split('/').at(-1)];
    return commit ? Response.json({ gitHead: commit }) : new Response('', { status: 404 });
  }
  if (url.startsWith('https://crates.io/api/v1/crates/')) {
    const commit = state.crateCommits[url.split('/').at(-1)];
    return commit ? Response.json({ version: { trustpub_data: { sha: commit } } }) : new Response('', { status: 404 });
  }
  if (url === '${oidcUrl}&audience=crates.io') return Response.json({ value: 'jwt' });
  if (url === 'https://crates.io/api/v1/trusted_publishing/tokens') {
    return method === 'POST' ? Response.json({ token: 'crates-token' }) : new Response(null, { status: 204 });
  }
  throw new Error('Unexpected request: ' + method + ' ' + url);
}
`;

const logTool = (tool: string): string => `#!/bin/sh
printf '{"tool":"${tool}","args":"%s","token":"%s"}\\n' "$*" "$CARGO_REGISTRY_TOKEN" >> "$RELEASE_TEST_LOG"
`;

interface Draft {
  id: number;
  tag_name: string;
  target_commitish: string;
}

interface Request {
  tool: string;
  method?: string;
  url?: string;
  body?: unknown;
  args?: string;
  token?: string;
}

type Failure = 'drop' | 'dropAfterProcessing' | 'rateLimit' | 'serverError' | 'validationError';

interface RunOptions {
  refName?: string;
  drafts?: Draft[];
  npmCommits?: Record<string, string>;
  crateCommits?: Record<string, string>;
  inCi?: boolean;
  failures?: Record<string, Failure>;
  crate?: string;
  plugin?: boolean;
  // `default` omits the option, so that semantic-release applies its default branches.
  branches?: unknown[] | 'default';
}

interface RunResult {
  status: number | null;
  output: string;
  requests: Request[];
  head: string;
  remoteTags: string[];
}

function runRelease(
  args: string[],
  {
    refName = 'main',
    drafts = [],
    npmCommits = {},
    crateCommits = {},
    inCi = true,
    failures = {},
    crate = 'release-test',
    plugin = true,
    branches = ['main'],
  }: RunOptions = {}
): RunResult {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-release-plugin-test-'));
  try {
    const repoDirPath = path.join(dirPath, 'repo');
    const remoteDirPath = path.join(dirPath, 'remote.git');
    const binDirPath = path.join(dirPath, 'bin');
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd: string, ...gitArgs: string[]): string => {
      const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', env: gitEnv });
      if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr}`);
      return result.stdout.trim();
    };

    writeFiles(repoDirPath, {
      'package.json': JSON.stringify({ name: 'release-test', private: true }),
      'pkg/package.json': JSON.stringify({ name: '@willbooster/release-test', version: '0.0.0-semantically-released' }),
      '.releaserc.json': JSON.stringify({
        ...(branches !== 'default' && { branches }),
        plugins: [
          '@semantic-release/commit-analyzer',
          '@semantic-release/release-notes-generator',
          ...(plugin ? [['@willbooster/wb/release-plugin', { ...(crate && { crate }), pkgRoot: 'pkg' }]] : []),
        ],
      }),
      '.gitignore': 'node_modules\n',
    });
    writeFiles(repoDirPath, { 'script/build-release': logTool('build-release') }, 0o755);
    writeFiles(binDirPath, { npm: logTool('npm'), cargo: logTool('cargo') }, 0o755);
    fs.mkdirSync(path.join(repoDirPath, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(repoDirPath, 'node_modules', '@willbooster'));
    fs.symlinkSync(semanticReleaseBinPath, path.join(repoDirPath, 'node_modules', '.bin', 'semantic-release'));
    fs.symlinkSync(wbDirPath, path.join(repoDirPath, 'node_modules', '@willbooster', 'wb'));
    fs.writeFileSync(path.join(dirPath, 'fakeApi.mjs'), fakeApi);
    const logPath = path.join(dirPath, 'requests.jsonl');
    fs.writeFileSync(logPath, '');

    git(dirPath, 'init', '--quiet', '--bare', '--initial-branch=main', remoteDirPath);
    git(repoDirPath, 'init', '--quiet', '--initial-branch=main');
    git(repoDirPath, 'add', '.');
    git(
      repoDirPath,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'fix: test'
    );
    git(repoDirPath, 'remote', 'add', 'origin', `file://${remoteDirPath}`);
    git(repoDirPath, 'push', '--quiet', 'origin', 'main');
    const head = git(repoDirPath, 'rev-parse', 'HEAD');
    const statePath = path.join(dirPath, 'state.json');
    const resolveCommit = (commit: string): string => (commit === headCommit ? head : commit);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        releases: drafts.map((draft) => ({
          ...draft,
          target_commitish: resolveCommit(draft.target_commitish),
          draft: true,
          body: `notes${pendingMarker}`,
          html_url: 'https://github.com/release',
        })),
        npmCommits: Object.fromEntries(Object.entries(npmCommits).map(([version, c]) => [version, resolveCommit(c)])),
        crateCommits: Object.fromEntries(
          Object.entries(crateCommits).map(([version, c]) => [version, resolveCommit(c)])
        ),
        // The release workflow runs on an existing branch.
        refs: { [`refs/heads/${refName}`]: head },
        failures,
      })
    );

    const result = spawnSync(nodePath as string, [path.join(wbDirPath, 'bin', 'index.js'), 'release', ...args], {
      cwd: repoDirPath,
      encoding: 'utf8',
      // Only what a release job provides, so that semantic-release detects no CI service (e.g., a pull request run
      // of the test itself) and git reads no user configuration.
      env: {
        ...gitEnv,
        PATH: `${binDirPath}${path.delimiter}${process.env.PATH}`,
        HOME: dirPath,
        CI: inCi ? 'true' : '',
        GITHUB_ACTIONS: '',
        GITHUB_EVENT_NAME: '',
        GITHUB_REF: '',
        GITHUB_REF_NAME: refName,
        GITHUB_REPOSITORY: repository,
        GITHUB_TOKEN: 'fake',
        ACTIONS_ID_TOKEN_REQUEST_URL: oidcUrl,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake',
        NODE_OPTIONS: `--import=${path.join(dirPath, 'fakeApi.mjs')}`,
        RELEASE_TEST_LOG: logPath,
        RELEASE_TEST_STATE: statePath,
      },
    });
    const requests = fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Request);
    const remoteTags = git(remoteDirPath, 'tag', '--list').split('\n').filter(Boolean);
    return { status: result.status, output: result.stdout + result.stderr, requests, head, remoteTags };
  } finally {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function writeFiles(dirPath: string, files: Record<string, string>, mode?: number): void {
  for (const [filePath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dirPath, filePath)), { recursive: true });
    fs.writeFileSync(path.join(dirPath, filePath), content, { mode });
  }
}

/** Formats the requests that change something, with the repository head as `HEAD` and generated notes as `<notes>`. */
function writesOf({ requests, head }: RunResult): string[] {
  return requests
    .filter((request) => request.tool !== 'fetch' || request.method !== 'GET')
    .map(({ tool, method, url, body, args, token }) => {
      if (tool !== 'fetch') return `${tool} ${args}${token ? ` (token ${token})` : ''}`;
      const route = url?.replace(`https://api.github.com/repos/${repository}/`, '');
      const text = JSON.stringify(body, (key, value: unknown) =>
        key === 'body' && typeof value === 'string' && !value.startsWith('notes')
          ? `<notes>${value.endsWith(pendingMarker) ? pendingMarker : ''}`
          : value
      );
      return `${method} ${route}${text ? ` ${text}` : ''}`.replaceAll(head, 'HEAD');
    });
}

// GitHub lists the newest release first: v1.0.2 is held by npm, and v1.0.1 by no registry.
const olderDrafts: Draft[] = [
  { id: 2, tag_name: 'v1.0.2', target_commitish: olderCommit },
  { id: 1, tag_name: 'v1.0.1', target_commitish: olderCommit },
];
const olderNpmCommits = { '1.0.2': olderCommit };
const createPendingBranch = `POST git/refs {"ref":"refs/heads/release-pending/v1.0.2","sha":"${olderCommit}"}`;
const dispatchPendingBranch = 'POST actions/workflows/release.yml/dispatches {"ref":"release-pending/v1.0.2"}';
const deferralWrites = ['DELETE releases/1', createPendingBranch, dispatchPendingBranch];

for (const [args, inCi] of [
  [[], true],
  [['--', '--debug'], true],
  [['--', '--no-ci'], false],
] as const) {
  test(
    `a real run with [${args.join(' ')}] ${inCi ? 'in CI' : 'outside CI'} deletes an unheld draft and dispatches the pending release instead of releasing`,
    () => {
      const result = runRelease([...args], { drafts: olderDrafts, npmCommits: olderNpmCommits, inCi });

      expect(result.status, result.output).toBe(0);
      expect(writesOf(result)).toEqual(deferralWrites);
      expect(result.remoteTags).toEqual([]);
    },
    timeout
  );
}

test(
  'a real run without a pending release publishes every target before publishing the draft release',
  () => {
    const result = runRelease([]);

    expect(result.status, result.output).toBe(0);
    expect(writesOf(result)).toEqual([
      'build-release 1.0.0',
      String.raw`POST releases {"tag_name":"v1.0.0","target_commitish":"HEAD","name":"v1.0.0","body":"<notes>\n\n<!-- pending release -->","draft":true}`,
      'cargo publish --dry-run --allow-dirty -p release-test',
      'npm publish --dry-run',
      'POST https://crates.io/api/v1/trusted_publishing/tokens {"jwt":"jwt"}',
      'cargo publish -p release-test --allow-dirty (token crates-token)',
      'DELETE https://crates.io/api/v1/trusted_publishing/tokens',
      'npm publish',
      'PATCH releases/1 {"draft":false,"body":"<notes>"}',
    ]);
    expect(result.remoteTags).toEqual(['v1.0.0']);
  },
  timeout
);

test(
  'a real run without a crate publishes only the npm package',
  () => {
    const result = runRelease([], { crate: '', npmCommits: { '1.0.0': headCommit } });

    expect(result.status, result.output).toBe(0);
    expect(writesOf(result)).toEqual([
      'build-release 1.0.0',
      String.raw`POST releases {"tag_name":"v1.0.0","target_commitish":"HEAD","name":"v1.0.0","body":"<notes>\n\n<!-- pending release -->","draft":true}`,
      'PATCH releases/1 {"draft":false,"body":"<notes>"}',
    ]);
    expect(result.output).toContain('Skipped @willbooster/release-test@1.0.0 on npm, which is already published from');
    expect(result.remoteTags).toEqual(['v1.0.0']);
  },
  timeout
);

test(
  'a real run returns the draft that a dropped POST created without repeating the POST',
  () => {
    const result = runRelease([], {
      npmCommits: { '1.0.0': headCommit },
      crateCommits: { '1.0.0': headCommit },
      failures: { 'POST /releases': 'dropAfterProcessing' },
    });

    expect(result.status, result.output).toBe(0);
    expect(writesOf(result)).toEqual([
      'build-release 1.0.0',
      String.raw`POST releases {"tag_name":"v1.0.0","target_commitish":"HEAD","name":"v1.0.0","body":"<notes>\n\n<!-- pending release -->","draft":true}`,
      'PATCH releases/1 {"draft":false,"body":"<notes>"}',
    ]);
    expect(result.remoteTags).toEqual(['v1.0.0']);
  },
  timeout
);

test(
  'a real run refuses a registry holding the version from another commit',
  () => {
    const result = runRelease([], { npmCommits: { '1.0.0': olderCommit } });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`@willbooster/release-test@1.0.0 on npm was published from ${olderCommit}`);
    expect(writesOf(result)).toEqual([
      'build-release 1.0.0',
      String.raw`POST releases {"tag_name":"v1.0.0","target_commitish":"HEAD","name":"v1.0.0","body":"<notes>\n\n<!-- pending release -->","draft":true}`,
    ]);
    expect(result.remoteTags).toEqual([]);
  },
  timeout
);

test(
  'a real run retries transient failures of GitHub and the registries',
  () => {
    const result = runRelease([], {
      drafts: olderDrafts,
      npmCommits: olderNpmCommits,
      failures: {
        'GET /releases?per_page=100': 'drop',
        'GET https://registry.npmjs.org/': 'serverError',
        'DELETE /releases/1': 'dropAfterProcessing',
        'POST /git/refs': 'dropAfterProcessing',
        'POST /actions/workflows/release.yml/dispatches': 'rateLimit',
      },
    });

    expect(result.status, result.output).toBe(0);
    expect(writesOf(result)).toEqual([
      'DELETE releases/1',
      'DELETE releases/1',
      createPendingBranch,
      dispatchPendingBranch,
      dispatchPendingBranch,
    ]);
  },
  timeout
);

for (const [crateCommits, crate] of [
  [{ '1.0.2': headCommit }, 'release-test'],
  [{}, ''],
] as const) {
  test(
    `a real run on a pending-release branch ${crate ? 'with a crate already published' : 'without a crate'} publishes the rest and hands over to the release branch`,
    () => {
      const result = runRelease([], {
        refName: 'release-pending/v1.0.2',
        drafts: [{ id: 3, tag_name: 'v1.0.2', target_commitish: headCommit }],
        crateCommits,
        crate,
      });

      expect(result.status, result.output).toBe(0);
      expect(writesOf(result)).toEqual([
        'build-release 1.0.2',
        'npm publish --dry-run',
        'npm publish',
        'PATCH releases/3 {"draft":false,"body":"notes"}',
        'POST actions/workflows/release.yml/dispatches {"ref":"main"}',
        'DELETE git/refs/heads/release-pending/v1.0.2',
      ]);
    },
    timeout
  );
}

test(
  'a real run on a pending-release branch retries deleting the branch after a dropped connection',
  () => {
    const result = runRelease([], {
      refName: 'release-pending/v1.0.2',
      failures: { 'DELETE /git/refs/heads/release-pending/v1.0.2': 'dropAfterProcessing' },
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('The release v1.0.2 is not pending.');
    expect(writesOf(result)).toEqual([
      'POST actions/workflows/release.yml/dispatches {"ref":"main"}',
      'DELETE git/refs/heads/release-pending/v1.0.2',
      'DELETE git/refs/heads/release-pending/v1.0.2',
    ]);
  },
  timeout
);

test(
  'a run outside CI without --no-ci reports the deferral without writes',
  () => {
    const result = runRelease([], { drafts: olderDrafts, npmCommits: olderNpmCommits, inCi: false });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Would delete the draft release v1.0.1');
    expect(result.output).toContain('Would dispatch a run on release-pending/v1.0.2');
    expect(writesOf(result)).toEqual([]);
  },
  timeout
);

for (const args of [['--dry-run'], ['--dry'], ['-d'], ['--', '--dry-run'], ['--', '-d']]) {
  test(
    `a dry run with ${args.join(' ')} reports the deferral without writes`,
    () => {
      const result = runRelease(args, { drafts: olderDrafts, npmCommits: olderNpmCommits });

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('Would delete the draft release v1.0.1');
      expect(result.output).toContain('Would dispatch a run on release-pending/v1.0.2');
      expect(writesOf(result)).toEqual([]);
    },
    timeout
  );
}

for (const [args, releaseBranch] of [
  [['--dry-run'], 'main'],
  [['--', '--dry-run', '--branches', 'next'], 'next'],
] as const) {
  test(
    `a dry run with ${args.join(' ')} on a pending-release branch reports completing the release without writes`,
    () => {
      const result = runRelease([...args], {
        refName: 'release-pending/v1.0.2',
        drafts: [{ id: 3, tag_name: 'v1.0.2', target_commitish: headCommit }],
      });

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('Would build and publish the pending release v1.0.2');
      expect(result.output).toContain(
        `Would dispatch a run on ${releaseBranch} and delete the branch release-pending/v1.0.2`
      );
      expect(writesOf(result)).toEqual([]);
    },
    timeout
  );
}

test(
  'a dry run on a pending-release branch dispatches on the name of an object-valued release branch',
  () => {
    const result = runRelease(['--dry-run'], {
      refName: 'release-pending/v1.0.2',
      branches: [{ name: 'main', channel: 'latest' }],
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Would dispatch a run on main and delete the branch release-pending/v1.0.2');
  },
  timeout
);

test(
  "semantic-release's default branches are refused before any request",
  () => {
    const result = runRelease(['--dry-run'], { branches: 'default' });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('to name the release branch first');
    expect(result.requests).toEqual([]);
  },
  timeout
);

test(
  'a semantic-release dry run with --debug and no pending release writes nothing',
  () => {
    const result = runRelease(['--', '--dry-run', '--debug']);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Release note for version 1.0.0');
    expect(writesOf(result)).toEqual([]);
    expect(result.remoteTags).toEqual([]);
  },
  timeout
);

test(
  'a repository without the plugin makes no request before semantic-release',
  () => {
    const result = runRelease(['--dry-run'], { drafts: olderDrafts, npmCommits: olderNpmCommits, plugin: false });

    expect(result.status, result.output).toBe(0);
    expect(result.requests).toEqual([]);
  },
  timeout
);

for (const args of [
  ['--', '--dry-run=true'],
  ['--', '--d'],
  ['--', '-vd'],
  ['--', '-d', '--no-d'],
  ['--', '--dry'],
  ['--', '--ci=false'],
  ['--', '--branches'],
  ['--', '--branches', 'main,next'],
  ['main'],
]) {
  test(
    `${args.join(' ')} is refused before any request`,
    () => {
      const result = runRelease(args, { drafts: olderDrafts, npmCommits: olderNpmCommits });

      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Unsupported argument');
      expect(result.requests).toEqual([]);
    },
    timeout
  );
}

for (const args of [['--debug'], ['--no-ci']]) {
  test(
    `wb's unknown option ${args.join(' ')} is refused before any request`,
    () => {
      const result = runRelease(args, { drafts: olderDrafts, npmCommits: olderNpmCommits });

      expect(result.status).not.toBe(0);
      expect(result.requests).toEqual([]);
    },
    timeout
  );
}

for (const failure of ['drop', 'serverError'] as const) {
  test(
    `a real run fails instead of repeating a dispatch that GitHub may have processed (${failure})`,
    () => {
      const result = runRelease([], {
        drafts: olderDrafts,
        npmCommits: olderNpmCommits,
        failures: { 'POST /actions/workflows/release.yml/dispatches': failure },
      });

      expect(result.status).not.toBe(0);
      expect(writesOf(result)).toEqual(deferralWrites);
    },
    timeout
  );
}

test(
  'a real run reports why creating the pending-release branch failed',
  () => {
    const result = runRelease([], {
      drafts: olderDrafts,
      npmCommits: olderNpmCommits,
      failures: { 'POST /git/refs': 'validationError' },
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('POST git/refs failed: 422');
  },
  timeout
);
