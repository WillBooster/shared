import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parse } from 'jsonc-parser';
import { z } from 'zod';

import type { Project } from '../project.js';
import { createWranglerDeployEnv } from './wranglerDeployEnv.js';

const execute = promisify(execFile);
const namedImageSchema = z
  .object({ dockerfile: z.string().optional(), build_context: z.string().optional() })
  .passthrough();
const containerSchema = z
  .object({
    class_name: z.string().optional(),
    name: z.string().optional(),
    image: z.string().optional(),
    image_build_context: z.string().optional(),
    image_vars: z.record(z.string(), z.coerce.string()).optional(),
    images: z.record(z.string(), namedImageSchema).optional(),
  })
  .passthrough();
const configSchema = z
  .object({
    containers: z.array(containerSchema).optional(),
    env: z.record(z.string(), z.object({ containers: z.array(containerSchema).optional() }).passthrough()).optional(),
  })
  .passthrough();

type Container = z.infer<typeof containerSchema>;
type LocalContainer = Container & { image: string };

interface ContainerImageDeployment {
  project: Project;
  configPath: string;
  workerName: string;
  envName?: string;
  deploy: (configPath: string) => Promise<void>;
}

export async function withReusableContainerImages({
  project,
  configPath,
  workerName,
  envName,
  deploy,
}: ContainerImageDeployment): Promise<void> {
  const absoluteConfigPath = path.resolve(project.dirPath, configPath);
  const config = configSchema.parse(parse(fs.readFileSync(absoluteConfigPath, 'utf8')));
  const selected = (envName ? config.env?.[envName] : undefined) ?? config;
  const containers = selected.containers ?? [];
  const configDir = path.dirname(absoluteConfigPath);
  const localContainers = containers.filter(
    (container): container is LocalContainer =>
      container.image !== undefined && fs.existsSync(path.resolve(configDir, container.image))
  );
  const env = createWranglerDeployEnv(project.env);
  const cancellation = new AbortController();
  const wranglerArgs = ['--config', absoluteConfigPath, ...(envName ? ['--env', envName] : [])];
  const run = async (command: string, args: string[], cwd = project.dirPath): Promise<string> => {
    const result = await execute(command, args, { cwd, env, signal: cancellation.signal, maxBuffer: 64 * 1024 * 1024 });
    return result.stdout.trim();
  };
  // Wrangler builds these itself from the working tree, so only committed sources may be there.
  for (const container of containers) {
    for (const image of Object.values(container.images ?? {})) {
      if (image.dockerfile)
        await assertCommittedNamedImageSource(configDir, image.dockerfile, image.build_context, run);
    }
  }
  if (localContainers.length === 0) return deploy(configPath);
  const registry = z
    .array(z.object({ name: z.string(), tags: z.array(z.string()) }))
    .parse(JSON.parse(await run('wrangler', ['containers', 'images', 'list', '--json', ...wranglerArgs])));
  const { temporaryDir, temporaryConfig, dispose } = createTemporaryImageFiles(absoluteConfigPath, cancellation);
  try {
    for (const container of localContainers) {
      await reuseContainerImage(container, {
        configDir,
        workerName,
        temporaryDir,
        registry,
        wranglerArgs,
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
  workerName: string;
  temporaryDir: string;
  registry: { name: string; tags: string[] }[];
  wranglerArgs: string[];
  run: (command: string, args: string[], cwd?: string) => Promise<string>;
}

interface CommittedImageSource {
  key: string;
  treeish: string;
  repository: string;
  dockerfilePath: string;
  buildVars: (readonly [string, string | undefined])[];
}

async function assertCommittedNamedImageSource(
  configDir: string,
  dockerfile: string,
  buildContext: string | undefined,
  run: ImageContext['run']
): Promise<void> {
  const contextDir = path.resolve(configDir, buildContext ?? path.dirname(dockerfile));
  const repository = await run('git', ['rev-parse', '--show-toplevel'], contextDir);
  const contextPath = path.relative(repository, contextDir).split(path.sep).join('/') || '.';
  if (await run('git', ['status', '--porcelain', '--untracked-files=all', '--', contextPath], repository)) {
    throw new Error(`Commit container build context changes before deploying: ${contextDir}`);
  }
}

async function reuseContainerImage(container: LocalContainer, context: ImageContext): Promise<void> {
  const { registry } = context;
  const source = await resolveCommittedImageSource(container, context);
  const imageName = container.name || container.class_name;
  if (!imageName) throw new Error('Reusable container images require name or class_name.');
  const repositoryName = `wb/${imageName.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')}`;
  const tag = `source-${source.key}`;
  const image = `${repositoryName}:${tag}`;
  if (!registry.some((entry) => entry.name === repositoryName && entry.tags.includes(tag))) {
    await buildAndPushImage(image, source, context);
    registry.push({ name: repositoryName, tags: [tag] });
  } else {
    console.info(`Reusing published container image ${image}.`);
  }
  container.image = image;
  delete container.image_build_context;
  delete container.image_vars;
}

async function resolveCommittedImageSource(
  container: LocalContainer,
  context: ImageContext
): Promise<CommittedImageSource> {
  const { configDir, workerName, run } = context;
  let dockerfile = path.resolve(configDir, container.image);
  if (fs.statSync(dockerfile).isDirectory()) dockerfile = path.join(dockerfile, 'Dockerfile');
  const buildContext = path.resolve(configDir, container.image_build_context ?? path.dirname(dockerfile));
  const repository = await run('git', ['rev-parse', '--show-toplevel'], buildContext);
  const contextPath = path.relative(repository, buildContext).split(path.sep).join('/');
  const dockerfilePath = path.relative(buildContext, dockerfile);
  if (dockerfilePath.startsWith('..') || path.isAbsolute(dockerfilePath)) {
    throw new Error('Container image reuse requires the Dockerfile inside its committed build context.');
  }
  const revision = await run('git', ['rev-parse', 'HEAD'], repository);
  const treeish = `${revision}:${contextPath}`;
  const tree = await run('git', ['rev-parse', treeish], repository);
  if (await run('git', ['diff', revision, '--', contextPath || '.'], repository)) {
    throw new Error(`Commit container build context changes before deploying: ${buildContext}`);
  }
  const vars = container.image_vars ?? {};
  const buildVars = Object.keys(vars)
    .toSorted()
    .map((name) => [name, vars[name]] as const);
  const key = createHash('sha256')
    .update(JSON.stringify({ tree, workerName, dockerfilePath, buildVars, platform: 'linux/amd64' }))
    .digest('hex');
  return { key, treeish, repository, dockerfilePath, buildVars };
}

async function buildAndPushImage(image: string, source: CommittedImageSource, context: ImageContext): Promise<void> {
  const { key, treeish, repository, dockerfilePath, buildVars } = source;
  const { temporaryDir, run } = context;
  const archive = path.join(temporaryDir, `${key}.tar`);
  const directory = path.join(temporaryDir, key);
  fs.mkdirSync(directory, { recursive: true });
  await run('git', ['archive', '--format=tar', `--output=${archive}`, treeish], repository);
  await run('tar', ['-xf', archive, '-C', directory]);
  const stagedDockerfile = path.join(directory, dockerfilePath);
  if (!fs.existsSync(stagedDockerfile)) throw new Error(`Container Dockerfile must be committed: ${dockerfilePath}`);
  console.info(`Building container image ${image} from committed context.`);
  await run('docker', [
    'build',
    '--load',
    '--provenance=false',
    '--platform',
    'linux/amd64',
    '-f',
    stagedDockerfile,
    '-t',
    image,
    ...buildVars.flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
    directory,
  ]);
  await run('wrangler', ['containers', 'push', image, ...context.wranglerArgs]);
}
