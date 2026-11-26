import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';

import { buildWb } from '../helpers/build.js';
import { createCloudflareProjectDir } from '../helpers/cloudflareProject.js';

const cliPath = path.resolve('bin/index.js');
const accountId = '0123456789abcdef0123456789abcdef';
const {
  BUN_TEST_WORKER_ID: _bunWorkerId,
  JEST_WORKER_ID: _jestWorkerId,
  WB_CLOUDFLARE_STATE_DIR: _stateDir,
  ...baseEnv
} = process.env;

let certificateDirPath: string;
let registryServer: ReturnType<typeof Bun.serve>;
let apiServer: ReturnType<typeof Bun.serve>;
let dirPath: string;
let apiRequests: string[];

beforeAll(buildWb, 120_000);
beforeAll(async () => {
  // wb looks images up over HTTPS, so the fake registry serves a certificate wb is told to trust.
  certificateDirPath = await createCloudflareProjectDir();
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      path.join(certificateDirPath, 'key.pem'),
      '-out',
      path.join(certificateDirPath, 'cert.pem'),
    ],
    { stdio: 'pipe' }
  );
  registryServer = Bun.serve({
    port: 0,
    tls: {
      cert: await fs.readFile(path.join(certificateDirPath, 'cert.pem'), 'utf8'),
      key: await fs.readFile(path.join(certificateDirPath, 'key.pem'), 'utf8'),
    },
    async fetch(request) {
      const match = /^\/v2\/(.+)\/manifests\/([^/]+)$/u.exec(new URL(request.url).pathname);
      if (request.method !== 'HEAD' || !match) return new Response(undefined, { status: 400 });
      if (request.headers.get('authorization') !== `Basic ${btoa('v1:registry-password')}`) {
        return new Response(undefined, { status: 401 });
      }
      const registry = await readRegistry();
      const digest = registry[`${match[1]}:${match[2]}`];
      return digest
        ? new Response(undefined, { headers: { 'Docker-Content-Digest': digest } })
        : new Response(undefined, { status: 404 });
    },
  });
  // cf itself requests the registry credentials, from this API.
  apiServer = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      apiRequests.push(`${request.method} ${pathname}`);
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          account_id: accountId,
          registry_host: `localhost:${registryServer.port}`,
          username: 'v1',
          password: 'registry-password',
        },
      });
    },
  });
});
afterAll(async () => {
  await registryServer.stop(true);
  await apiServer.stop(true);
  await fs.rm(certificateDirPath, { force: true, recursive: true });
});
beforeEach(async () => {
  apiRequests = [];
  dirPath = await createContainerWorkerProject();
});
afterEach(async () => {
  await fs.rm(dirPath, { force: true, recursive: true });
});

it('builds an image from the committed context only when it is not published, and deploys its digest', async () => {
  // Untracked files must never reach the image.
  await fs.writeFile(path.join(dirPath, 'agent/untracked.txt'), 'untracked');

  const first = await deploy(['--containers-rollout=gradual']);
  expect(first.status, first.stdout + first.stderr).toBe(0);
  const firstReference = await readBuiltImageReference();
  expect(await readDockerBuilds()).toEqual([{ source: 'v1', untracked: false }]);
  expect(firstReference).toBe(
    `localhost:${registryServer.port}/${accountId}/wb/runner-app@${Object.values(await readRegistry())[0]}`
  );
  expect(await readDeployRollouts()).toEqual(['gradual', 'gradual']);
  // The secret registry password never appears in wb's output.
  expect(first.stdout + first.stderr).not.toContain('registry-password');

  const second = await deploy(['--containers-rollout=immediate']);
  expect(second.status, second.stdout + second.stderr).toBe(0);
  expect(await readDockerBuilds()).toHaveLength(1);
  expect(await readBuiltImageReference()).toBe(firstReference);

  await fs.writeFile(path.join(dirPath, 'agent/source.txt'), 'v2');
  git('commit', '-qam', 'change the image');
  const third = await deploy(['--containers-rollout=gradual']);
  expect(third.status, third.stdout + third.stderr).toBe(0);
  expect(await readDockerBuilds()).toEqual([
    { source: 'v1', untracked: false },
    { source: 'v2', untracked: false },
  ]);
  const thirdReference = await readBuiltImageReference();
  expect(thirdReference).not.toBe(firstReference);
  expect(Object.values(await readRegistry())).toHaveLength(2);
}, 240_000);

it('stops before any build when the build context has uncommitted changes', async () => {
  await fs.writeFile(path.join(dirPath, 'agent/source.txt'), 'uncommitted');

  const result = await deploy(['--containers-rollout=gradual']);

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain('Commit the changes to the build context of the container image');
  expect(await readDockerBuilds()).toEqual([]);
  expect(apiRequests).toEqual([]);
  expect(await fs.exists(path.join(dirPath, '.cloudflare/output'))).toBe(false);
}, 120_000);

it('deploys without Docker or the registry, keeping the deployed containers, unless a rollout is requested', async () => {
  await fs.writeFile(path.join(dirPath, 'agent/source.txt'), 'uncommitted');

  for (const args of [['--containers-rollout=none'], []]) {
    const result = await deploy(args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }

  expect(await readDockerBuilds()).toEqual([]);
  expect(apiRequests).toEqual([]);
  expect(await readDeployRollouts()).toEqual(['none', 'none', 'none', 'none']);
}, 120_000);

it('stops before any image work when the config does not take the image reference wb sets', async () => {
  const configPath = path.join(dirPath, 'cloudflare.config.ts');
  const config = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, config.replace('process.env.WB_CONTAINER_IMAGE_RUNNER_APP', 'undefined'));

  for (const args of [[], ['--containers-rollout=gradual']]) {
    const result = await deploy(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('runner-app (WB_CONTAINER_IMAGE_RUNNER_APP)');
  }

  expect(await readDockerBuilds()).toEqual([]);
  expect(apiRequests).toEqual([]);
  expect(await fs.exists(path.join(dirPath, '.cloudflare/output'))).toBe(false);
}, 120_000);

async function deploy(args: string[]): Promise<Awaited<ReturnType<typeof spawnAsync>>> {
  return spawnAsync('node', [cliPath, 'deploy', ...args], {
    cwd: dirPath,
    env: {
      ...baseEnv,
      PATH: `${path.join(dirPath, 'fake-bin')}:${baseEnv.PATH}`,
      CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${apiServer.port}/client/v4`,
      // Nothing here contacts Cloudflare.
      CLOUDFLARE_API_TOKEN: 'unused-token',
      CLOUDFLARE_CONTAINER_REGISTRY: `localhost:${registryServer.port}`,
      NODE_EXTRA_CA_CERTS: path.join(certificateDirPath, 'cert.pem'),
      WB_ENV: 'staging',
      WB_TEST_LOG_DIR: path.join(dirPath, 'log'),
    },
    timeout: 100_000,
  });
}

/**
 * A Git repository holding a Wrangler-bundled Worker with a Durable Object-managed container whose
 * image is built from `agent/Dockerfile`, written as wb's documentation tells projects to.
 */
async function createContainerWorkerProject(): Promise<string> {
  const projectDirPath = await createCloudflareProjectDir();
  await fs.writeFile(
    path.join(projectDirPath, 'package.json'),
    JSON.stringify({
      name: 'container-fixture',
      packageManager: 'bun@1.4.2',
      type: 'module',
      devDependencies: { cf: '1.0.0', wrangler: '4.0.0' },
    })
  );
  await fs.writeFile(
    path.join(projectDirPath, 'cloudflare.config.ts'),
    `import { defineConfig, defineContainer, exports } from 'cf/config';

const appImage = process.env.WB_CONTAINER_IMAGE_RUNNER_APP;
const runner = defineContainer({
  name: 'runner',
  schedulingPolicy: 'durable-object',
  images: {
    app: appImage ? { reference: appImage } : { dockerfile: './agent/Dockerfile', buildVars: { FLAVOR: 'small' } },
  },
});

export default defineConfig(({ mode = 'development' }) => ({
  accountId: '${accountId}',
  worker: {
    name: \`fixture-\${mode}\`,
    entrypoint: './src/index.ts',
    compatibilityDate: '2026-09-01',
    exports: { Runner: exports.durableObject({ storage: 'sqlite', container: runner }) },
  },
  containers: [runner],
}));
`
  );
  await fs.mkdir(path.join(projectDirPath, 'src'));
  await fs.writeFile(
    path.join(projectDirPath, 'src/index.ts'),
    `export class Runner {}
export default { fetch: () => new Response('ok') };
`
  );
  await fs.mkdir(path.join(projectDirPath, 'agent'));
  await fs.writeFile(path.join(projectDirPath, 'agent/Dockerfile'), 'FROM scratch\nCOPY source.txt /\n');
  await fs.writeFile(path.join(projectDirPath, 'agent/source.txt'), 'v1');
  await fs.writeFile(path.join(projectDirPath, '.gitignore'), 'node_modules\n.cloudflare\nlog\nfake-bin\n');
  await fs.mkdir(path.join(projectDirPath, 'log'));
  await fs.writeFile(path.join(projectDirPath, 'log/registry.json'), '{}');

  await fs.mkdir(path.join(projectDirPath, 'node_modules/.bin'), { recursive: true });
  await fs.symlink(path.resolve('node_modules/wrangler'), path.join(projectDirPath, 'node_modules/wrangler'));
  await writeFakeCommands(projectDirPath);

  dirPath = projectDirPath;
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'init');
  return projectDirPath;
}

/**
 * `cf` runs the real build and credential request, records each deploy, and stands in for the
 * push, which needs Docker and the registry; `docker` records the context of each image build.
 */
async function writeFakeCommands(projectDirPath: string): Promise<void> {
  const realCfPath = path.resolve('node_modules/.bin/cf');
  await fs.writeFile(
    path.join(projectDirPath, 'node_modules/.bin/cf'),
    `#!/bin/sh
case "$*" in
  build*|"containers registries credentials generate"*) exec "${realCfPath}" "$@" ;;
  "workers secrets list"*) echo '[]' ;;
  "containers push"*)
    node -e '
      const fs = require("node:fs");
      const [registryPath, image, account] = process.argv.slice(1);
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      registry[account + "/" + image] = "sha256:" + require("node:crypto").createHash("sha256").update(image).digest("hex");
      fs.writeFileSync(registryPath, JSON.stringify(registry));
    ' "$WB_TEST_LOG_DIR/registry.json" "$4" "$CLOUDFLARE_ACCOUNT_ID" ;;
  deploy*) printf '%s\\n' "$*" >> "$WB_TEST_LOG_DIR/deploys" ;;
  *) echo "unexpected cf call: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  await fs.mkdir(path.join(projectDirPath, 'fake-bin'));
  await fs.writeFile(
    path.join(projectDirPath, 'fake-bin/docker'),
    `#!/bin/sh
# cf's build lists the tags of its previous builds, which tolerates a missing Docker.
if [ "$1" != build ]; then exit 0; fi
for context; do :; done
untracked=false
if [ -e "$context/untracked.txt" ]; then untracked=true; fi
printf '{"source":"%s","untracked":%s}\\n' "$(cat "$context/source.txt")" "$untracked" >> "$WB_TEST_LOG_DIR/docker-builds"
`,
    { mode: 0o755 }
  );
}

function git(...args: string[]): void {
  execFileSync('git', args, {
    cwd: dirPath,
    env: {
      ...baseEnv,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: 'pipe',
  });
}

async function readRegistry(): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(path.join(dirPath, 'log/registry.json'), 'utf8')) as Record<string, string>;
}

async function readDockerBuilds(): Promise<unknown[]> {
  const logPath = path.join(dirPath, 'log/docker-builds');
  if (!(await fs.exists(logPath))) return [];
  const log = await fs.readFile(logPath, 'utf8');
  return log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

async function readDeployRollouts(): Promise<(string | undefined)[]> {
  const log = await fs.readFile(path.join(dirPath, 'log/deploys'), 'utf8');
  return log
    .trim()
    .split('\n')
    .map((line) => /--containers-rollout=(\S+)/u.exec(line)?.[1]);
}

async function readBuiltImageReference(): Promise<string> {
  const containerConfig = JSON.parse(
    await fs.readFile(path.join(dirPath, '.cloudflare/output/v1/containers/runner/container.config.json'), 'utf8')
  ) as { images: { app: { reference: string } } };
  return containerConfig.images.app.reference;
}
