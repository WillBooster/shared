import { afterEach, beforeAll, beforeEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWb } from '../helpers/build.js';

const cli = fileURLToPath(new URL('../../bin/index.js', import.meta.url));
const root = fileURLToPath(new URL('../../../../.tmp', import.meta.url));
let directory: string;

beforeAll(buildWb, 120_000);
beforeEach(() => {
  fs.mkdirSync(root, { recursive: true });
  directory = fs.mkdtempSync(path.join(root, 'container-images-'));
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, 'bin', 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(directory, 'registry.json'), '[]');
  fs.writeFileSync(path.join(directory, 'deployed.json'), '[]');
  const executable = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.FAKE_REGISTRY_DIR ?? ${JSON.stringify(directory)};
const registryPath = path.join(root, 'registry.json');
if (path.basename(process.argv[1]) === 'docker') {
  const context = args.at(-1);
  if (fs.existsSync(path.join(context, 'untracked.txt'))) throw new Error('Untracked input reached Docker');
  fs.appendFileSync(path.join(root, 'builds.jsonl'), JSON.stringify(fs.readFileSync(path.join(context, 'source.txt'), 'utf8')) + '\\n');
  if (process.env.HOLD_BUILD) {
    fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ artifact: path.dirname(context) }));
    setInterval(() => {}, 1000);
  }
} else if (path.basename(process.argv[1]) === 'vinext') {
  const config = JSON.parse(fs.readFileSync('wrangler.json', 'utf8'));
  config.main = '../../src.ts';
  config.containers[0].image = '../../agent/Dockerfile';
  fs.mkdirSync('dist/server', { recursive: true });
  fs.writeFileSync('dist/server/wrangler.json', JSON.stringify(config));
} else if (args[0] === 'secret') {
  console.log('[]');
} else if (args[0] === 'containers' && args[1] === 'images') {
  if (process.env.FAIL_REGISTRY) process.exit(7);
  console.log(fs.readFileSync(registryPath, 'utf8'));
} else if (args[0] === 'containers' && args[1] === 'push') {
  const [name, tag] = args[2].split(':');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.push({ name, tags: [tag] });
  fs.writeFileSync(registryPath, JSON.stringify(registry));
} else if (args[0] === 'deploy') {
  const configPath = args[args.indexOf('--config') + 1];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const deploys = JSON.parse(fs.readFileSync(path.join(root, 'deployed.json'), 'utf8'));
  const selected = args.includes('--env') ? config.env[args[args.indexOf('--env') + 1]] : config;
  if (!selected.containers[0].image.startsWith('registry.cloudflare.com/')) {
    require('node:child_process').execFileSync('docker', ['build', path.dirname(path.resolve(path.dirname(configPath), selected.containers[0].image))]);
  }
  if (args.includes('--dry-run')) process.exit(0);
  deploys.push({ image: selected.containers[0].image, configPath, main: path.resolve(path.dirname(configPath), config.main) });
  fs.writeFileSync(path.join(root, 'deployed.json'), JSON.stringify(deploys));
  if (process.env.FAIL_DEPLOY) process.exit(9);
  if (process.env.HOLD_DEPLOY) {
    fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ artifact: configPath }));
    setInterval(() => {}, 1000);
  }
}
`;
  for (const name of ['docker', 'wrangler', 'vinext']) {
    fs.writeFileSync(path.join(directory, 'bin', name), executable, { mode: 0o755 });
  }
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it('reuses a published image across checkouts and builds a changed committed context', async () => {
  const first = createProject('first');
  const second = createProject('second');
  fs.writeFileSync(path.join(second, 'agent', 'untracked.txt'), 'local generated output');
  await deploy(first);
  await deploy(second);
  let deployed = readDeployments();
  expect(deployed[0]?.image).toBe(deployed[1]?.image);
  expect(readBuilds()).toEqual(['original']);
  fs.writeFileSync(path.join(second, 'agent', 'source.txt'), 'updated');
  commit(second);
  await deploy(second);
  deployed = readDeployments();
  expect(deployed[2]?.image).not.toBe(deployed[1]?.image);
  expect(readBuilds()).toEqual(['original', 'updated']);
  for (const deployment of deployed) {
    expect(fs.existsSync(deployment.configPath)).toBe(false);
    expect(fs.existsSync(deployment.main)).toBe(true);
  }
}, 60_000);

it.each([false, true])('rejects tracked context edits (staged: %s)', async (staged) => {
  const project = createProject('dirty');
  fs.writeFileSync(path.join(project, 'agent', 'source.txt'), 'uncommitted');
  if (staged) git(project, ['add', 'agent/source.txt']);
  const result = await deploy(project, {}, false);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Commit container build context changes');
  expect(readBuilds()).toEqual([]);
  expect(readDeployments()).toEqual([]);
});

it('changes the image for build variables and resolves staging containers', async () => {
  const project = createProject('variables');
  await deploy(project);
  const configPath = path.join(project, 'wrangler.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.env = { staging: { containers: [{ ...config.containers[0], image_vars: { FLAVOR: 'staging' } }] } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  await deploy(project, { WB_ENV: 'staging' });
  const deployed = readDeployments();
  expect(deployed[1]?.image).not.toBe(deployed[0]?.image);
  expect(readBuilds()).toHaveLength(2);
});

it('uses the resolved named-environment account for registry images', async () => {
  const project = createProject('account');
  const configPath = path.join(project, 'wrangler.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.env = { staging: { account_id: 'staging-account', containers: config.containers } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  await deploy(project, { WB_ENV: 'staging' });
  expect(readDeployments()[0]?.image).toContain('registry.cloudflare.com/staging-account/');
});

it.each(['HOLD_BUILD', 'HOLD_DEPLOY'])(
  'cleans temporary resources on SIGTERM during %s',
  async (stage) => {
    const project = createProject('termination');
    const subprocess = spawnDeploy(project, { [stage]: '1' });
    try {
      const activePath = path.join(directory, 'active.json');
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(activePath) && subprocess.exitCode === null && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(fs.existsSync(activePath)).toBe(true);
      const { artifact } = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      subprocess.kill('SIGTERM');
      expect(await subprocess.exited).toBe(143);
      expect(fs.existsSync(artifact)).toBe(false);
      expect(fs.readdirSync(project).filter((name) => name.startsWith('.wb-deploy-'))).toEqual([]);
    } finally {
      subprocess.kill();
    }
  },
  20_000
);

it('preserves built vinext config paths while reusing its container image', async () => {
  const project = createProject('vinext');
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { vinext: '1.0.0' } })
  );
  await deploy(project);
  await deploy(project);
  const deployed = readDeployments();
  expect(deployed[0]?.image).toBe(deployed[1]?.image);
  expect(deployed[0]?.main).toBe(path.join(project, 'src.ts'));
  expect(readBuilds()).toEqual(['original']);
  expect(fs.readdirSync(path.join(project, 'dist', 'server'))).toEqual(['wrangler.json']);
});

it('cleans the sibling config after failed deployment and does not build after registry failure', async () => {
  const project = createProject('failure');
  const result = await deploy(project, { FAIL_DEPLOY: '1' }, false);
  expect(result.exitCode).toBe(9);
  expect(fs.existsSync(readDeployments()[0]!.configPath)).toBe(false);
  const builds = readBuilds().length;
  const failed = await deploy(project, { FAIL_REGISTRY: '1' }, false);
  expect(failed.exitCode).not.toBe(0);
  expect(readBuilds()).toHaveLength(builds);
  expect(fs.readdirSync(project).filter((name) => name.startsWith('.wb-deploy-'))).toEqual([]);
});

function createProject(name: string): string {
  const project = path.join(directory, name);
  fs.mkdirSync(path.join(project, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(project, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, type: 'module' })
  );
  fs.writeFileSync(path.join(project, 'src.ts'), 'export default {};');
  fs.writeFileSync(path.join(project, 'fnox.toml'), '[profiles.production]\n[profiles.staging]\n');
  fs.writeFileSync(path.join(project, 'agent', 'Dockerfile'), 'FROM scratch\nCOPY source.txt /source.txt\n');
  fs.writeFileSync(path.join(project, 'agent', 'source.txt'), 'original');
  fs.writeFileSync(
    path.join(project, 'wrangler.json'),
    JSON.stringify({
      name: 'fixture',
      account_id: 'account',
      main: 'src.ts',
      containers: [{ class_name: 'Agent', image: './agent/Dockerfile' }],
    })
  );
  git(project, ['init', '-q']);
  commit(project);
  return project;
}

function commit(project: string): void {
  git(project, ['add', 'agent/Dockerfile', 'agent/source.txt', 'package.json', 'src.ts', 'fnox.toml', 'wrangler.json']);
  git(project, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
    '--no-verify',
  ]);
}

function git(project: string, args: string[]): void {
  execFileSync('git', args, { cwd: project, stdio: 'pipe' });
}

async function deploy(
  project: string,
  env: Record<string, string> = {},
  succeeds = true
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const subprocess = spawnDeploy(project, env);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (succeeds) expect(exitCode, stdout + stderr).toBe(0);
  return { stdout, stderr, exitCode };
}

function spawnDeploy(project: string, env: Record<string, string>): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(['node', cli, 'deploy', '--reuse-container-images'], {
    cwd: project,
    env: {
      PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`,
      HOME: process.env.HOME,
      CI: 'true',
      WB_ENV: 'production',
      CLOUDFLARE_API_TOKEN: 'fixture-token',
      FAKE_REGISTRY_DIR: directory,
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function readDeployments(): { image: string; configPath: string; main: string }[] {
  return JSON.parse(fs.readFileSync(path.join(directory, 'deployed.json'), 'utf8'));
}

function readBuilds(): string[] {
  const file = path.join(directory, 'builds.jsonl');
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}
