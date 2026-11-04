import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parse } from 'jsonc-parser';
import { z } from 'zod';

import type { Project } from '../project.js';

const execute = promisify(execFile);
const containerSchema = z
  .object({
    class_name: z.string(),
    image: z.string(),
    image_build_context: z.string().optional(),
    image_vars: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const configSchema = z
  .object({
    name: z.string(),
    account_id: z.string().optional(),
    containers: z.array(containerSchema).optional(),
    env: z.record(z.string(), z.object({ containers: z.array(containerSchema).optional() }).passthrough()).optional(),
  })
  .passthrough();

type Container = z.infer<typeof containerSchema>;

interface ContainerImageDeployment {
  project: Project;
  configPath: string;
  envName: string;
  accountId?: string;
  deploy: (configPath: string) => Promise<void>;
}

export async function withReusableContainerImages({
  project,
  configPath,
  envName,
  accountId,
  deploy,
}: ContainerImageDeployment): Promise<void> {
  const absoluteConfigPath = path.resolve(project.dirPath, configPath);
  const config = configSchema.parse(parse(fs.readFileSync(absoluteConfigPath, 'utf8')));
  const selected = config.env?.[envName] ?? config;
  const containers = selected.containers ?? [];
  const localContainers = containers.filter((container) =>
    fs.existsSync(path.resolve(path.dirname(absoluteConfigPath), container.image))
  );
  if (localContainers.length === 0) return deploy(configPath);
  if (!accountId) throw new Error('--reuse-container-images requires account_id or CLOUDFLARE_ACCOUNT_ID.');
  const env = { ...project.env, CLOUDFLARE_ACCOUNT_ID: accountId };
  const cancellation = new AbortController();
  const run = async (command: string, args: string[], cwd = project.dirPath): Promise<string> => {
    const result = await execute(command, args, { cwd, env, signal: cancellation.signal, maxBuffer: 64 * 1024 * 1024 });
    return result.stdout.trim();
  };
  const registry = z
    .array(z.object({ name: z.string(), tags: z.array(z.string()) }))
    .parse(JSON.parse(await run('wrangler', ['containers', 'images', 'list', '--json'])));
  const { temporaryDir, temporaryConfig, dispose } = createTemporaryImageFiles(absoluteConfigPath, cancellation);
  try {
    for (const container of localContainers) {
      await reuseContainerImage(container, {
        configDir: path.dirname(absoluteConfigPath),
        temporaryDir,
        accountId,
        registry,
        run,
      });
    }
    fs.writeFileSync(temporaryConfig, JSON.stringify(config));
    await deploy(temporaryConfig);
  } finally {
    dispose();
  }
}

interface TemporaryImageFiles {
  temporaryDir: string;
  temporaryConfig: string;
  dispose: () => void;
}

function createTemporaryImageFiles(configPath: string, cancellation: AbortController): TemporaryImageFiles {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-container-images-'));
  const temporaryConfig = path.join(path.dirname(configPath), `.wb-deploy-${randomUUID()}.json`);
  const cleanup = (): void => {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    fs.rmSync(temporaryConfig, { force: true });
  };
  const handlers = (['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGQUIT'] as const).map(
    (signal) =>
      [
        signal,
        (): void => {
          cancellation.abort();
          cleanup();
          if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
        },
      ] as const
  );
  process.on('exit', cleanup);
  for (const [signal, handler] of handlers) process.once(signal, handler);
  return {
    temporaryDir,
    temporaryConfig,
    dispose: (): void => {
      process.off('exit', cleanup);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      cleanup();
    },
  };
}

interface ImageContext {
  configDir: string;
  temporaryDir: string;
  accountId: string;
  registry: { name: string; tags: string[] }[];
  run: (command: string, args: string[], cwd?: string) => Promise<string>;
}

interface CommittedImageSource {
  key: string;
  revision: string;
  contextPath: string;
  repository: string;
  dockerfilePath: string;
  buildVars: (readonly [string, string | undefined])[];
}

async function reuseContainerImage(container: Container, context: ImageContext): Promise<void> {
  const { configDir, accountId, registry, run } = context;
  let dockerfile = path.resolve(configDir, container.image);
  if (fs.statSync(dockerfile).isDirectory()) dockerfile = path.join(dockerfile, 'Dockerfile');
  const buildContext = path.resolve(configDir, container.image_build_context ?? path.dirname(dockerfile));
  const repository = await run('git', ['rev-parse', '--show-toplevel'], buildContext);
  const contextPath = path.relative(repository, buildContext).split(path.sep).join('/');
  const dockerfilePath = path.relative(buildContext, dockerfile);
  if (dockerfilePath.startsWith('..') || path.isAbsolute(dockerfilePath)) {
    throw new Error('--reuse-container-images requires the Dockerfile inside its committed build context.');
  }
  const revision = await run('git', ['rev-parse', 'HEAD'], repository);
  const tree = await run('git', ['rev-parse', `${revision}:${contextPath || '.'}`], repository);
  if (await run('git', ['diff', revision, '--', contextPath || '.'], repository)) {
    throw new Error(`Commit container build context changes before deploying: ${buildContext}`);
  }
  const vars = container.image_vars ?? {};
  const buildVars = Object.keys(vars)
    .toSorted()
    .map((name) => [name, vars[name]] as const);
  const key = createHash('sha256')
    .update(JSON.stringify({ tree, dockerfilePath, buildVars, platform: 'linux/amd64' }))
    .digest('hex');
  const repositoryName = `wb-${container.class_name.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')}`;
  const tag = `source-${key}`;
  const image = `${repositoryName}:${tag}`;
  if (!registry.some((entry) => entry.name === repositoryName && entry.tags.includes(tag))) {
    await buildAndPushImage(image, { key, revision, contextPath, repository, dockerfilePath, buildVars }, context);
    registry.push({ name: repositoryName, tags: [tag] });
  } else {
    console.info(`Reusing published container image ${image}.`);
  }
  container.image = `registry.cloudflare.com/${accountId}/${image}`;
  delete container.image_build_context;
  delete container.image_vars;
}

async function buildAndPushImage(image: string, source: CommittedImageSource, context: ImageContext): Promise<void> {
  const { key, revision, contextPath, repository, dockerfilePath, buildVars } = source;
  const { temporaryDir, run } = context;
  const archive = path.join(temporaryDir, `${key}.tar`);
  const directory = path.join(temporaryDir, key);
  fs.mkdirSync(directory, { recursive: true });
  await run('git', ['archive', '--format=tar', `--output=${archive}`, `${revision}:${contextPath || '.'}`], repository);
  await run('tar', ['-xf', archive, '-C', directory]);
  const stagedDockerfile = path.join(directory, dockerfilePath);
  if (!fs.existsSync(stagedDockerfile)) throw new Error(`Container Dockerfile must be committed: ${dockerfilePath}`);
  console.info(`Building container image ${image} from committed context.`);
  await run('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    stagedDockerfile,
    '-t',
    image,
    ...buildVars.flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
    directory,
  ]);
  await run('wrangler', ['containers', 'push', image]);
}
