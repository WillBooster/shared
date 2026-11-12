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
const registryCredentialsSchema = z.object({
  account_id: z.string(),
  registry_host: z.string(),
  username: z.string(),
  password: z.string(),
});
const configSchema = z
  .object({
    containers: z.array(containerSchema).optional(),
    env: z.record(z.string(), z.object({ containers: z.array(containerSchema).optional() }).passthrough()).optional(),
  })
  .passthrough();

type Container = z.infer<typeof containerSchema>;
type NamedImage = z.infer<typeof namedImageSchema>;
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
  const namedImages = containers.flatMap((container) =>
    Object.entries(container.images ?? {}).flatMap(([key, image]) =>
      image.dockerfile === undefined
        ? []
        : [{ name: `${getImageName(container)}-${key}`, dockerfile: image.dockerfile, image }]
    )
  );
  if (localContainers.length === 0 && namedImages.length === 0) return deploy(configPath);
  const { temporaryDir, temporaryConfig, dispose } = createTemporaryImageFiles(absoluteConfigPath, cancellation);
  try {
    const context: ImageContext = { configDir, workerName, temporaryDir, wranglerArgs, run };
    for (const { name, dockerfile, image } of namedImages) {
      await reuseNamedImage(name, dockerfile, image, context);
    }
    if (localContainers.length > 0) {
      const registry = z
        .array(z.object({ name: z.string(), tags: z.array(z.string()) }))
        .parse(JSON.parse(await run('wrangler', ['containers', 'images', 'list', '--json', ...wranglerArgs])));
      for (const container of localContainers) {
        await reuseContainerImage(container, registry, context);
      }
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
  wranglerArgs: string[];
  run: (command: string, args: string[], cwd?: string) => Promise<string>;
}

interface CommittedTree {
  repository: string;
  treeish: string;
  dockerfilePath: string;
}

interface CommittedImageSource extends CommittedTree {
  key: string;
  buildVars: (readonly [string, string | undefined])[];
}

function getImageName(container: Container): string {
  const imageName = container.name || container.class_name;
  if (!imageName) throw new Error('Reusable container images require name or class_name.');
  return imageName;
}

function toRepositoryName(imageName: string): string {
  return `wb/${imageName.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')}`;
}

async function reuseNamedImage(
  name: string,
  dockerfile: string,
  image: NamedImage,
  context: ImageContext
): Promise<void> {
  const source = await resolveCommittedImageSource(dockerfile, image.build_context, {}, context);
  const repositoryName = toRepositoryName(name);
  const tag = `source-${source.key}`;
  let reference = await findPublishedImage(repositoryName, tag, context);
  if (reference) {
    console.info(`Reusing published container image ${repositoryName}:${tag}.`);
  } else {
    await buildAndPushImage(`${repositoryName}:${tag}`, source, context);
    reference = await findPublishedImage(repositoryName, tag, context);
    if (!reference) throw new Error(`Pushed container image ${repositoryName}:${tag} is missing from the registry.`);
  }
  image.image = reference;
  delete image.dockerfile;
  delete image.build_context;
}

/**
 * Returns the digest-pinned reference of a published image, the only registry reference
 * Wrangler accepts for an `images` entry, or `undefined` when the tag is not published.
 */
async function findPublishedImage(
  repositoryName: string,
  tag: string,
  context: ImageContext
): Promise<string | undefined> {
  const credentials = registryCredentialsSchema.parse(
    JSON.parse(
      await context.run('wrangler', [
        'containers',
        'registries',
        'credentials',
        '--pull',
        '--json',
        ...context.wranglerArgs,
      ])
    )
  );
  const repository = `${credentials.account_id}/${repositoryName}`;
  const authorization = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  const response = await fetch(`https://${credentials.registry_host}/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Basic ${authorization}`,
      Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
    },
  });
  if (response.status === 404) return undefined;
  const digest = response.headers.get('Docker-Content-Digest');
  if (!response.ok || !digest) {
    throw new Error(`Failed to look up container image ${repositoryName}:${tag}: ${response.status}`);
  }
  return `${credentials.registry_host}/${repository}@${digest}`;
}

async function reuseContainerImage(
  container: LocalContainer,
  registry: { name: string; tags: string[] }[],
  context: ImageContext
): Promise<void> {
  const source = await resolveCommittedImageSource(
    container.image,
    container.image_build_context,
    container.image_vars ?? {},
    context
  );
  const repositoryName = toRepositoryName(getImageName(container));
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
  dockerfilePath: string,
  buildContextPath: string | undefined,
  vars: Record<string, string>,
  context: ImageContext
): Promise<CommittedImageSource> {
  const { configDir, workerName, run } = context;
  const dockerfile = resolveDockerfile(path.resolve(configDir, dockerfilePath));
  const buildContext = path.resolve(configDir, buildContextPath ?? path.dirname(dockerfile));
  const tree = await resolveCommittedTree(dockerfile, buildContext, run);
  const treeHash = await run('git', ['rev-parse', tree.treeish], tree.repository);
  const buildVars = Object.keys(vars)
    .toSorted()
    .map((name) => [name, vars[name]] as const);
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        tree: treeHash,
        workerName,
        dockerfilePath: tree.dockerfilePath,
        buildVars,
        platform: 'linux/amd64',
      })
    )
    .digest('hex');
  return { ...tree, key, buildVars };
}

function resolveDockerfile(dockerfile: string): string {
  return fs.statSync(dockerfile).isDirectory() ? path.join(dockerfile, 'Dockerfile') : dockerfile;
}

async function resolveCommittedTree(
  dockerfile: string,
  buildContext: string,
  run: ImageContext['run']
): Promise<CommittedTree> {
  const repository = await run('git', ['rev-parse', '--show-toplevel'], buildContext);
  const contextPath = path.relative(repository, buildContext);
  const dockerfilePath = path.relative(buildContext, dockerfile);
  if (dockerfilePath.startsWith('..') || path.isAbsolute(dockerfilePath)) {
    throw new Error('Container images require the Dockerfile inside their committed build context.');
  }
  const revision = await run('git', ['rev-parse', 'HEAD'], repository);
  if (await run('git', ['diff', revision, '--', contextPath || '.'], repository)) {
    throw new Error(`Commit container build context changes before deploying: ${buildContext}`);
  }
  return { repository, treeish: `${revision}:${contextPath}`, dockerfilePath };
}

/** Extracts the committed build context into `directory` and returns the path of its Dockerfile there. */
async function extractCommittedTree(tree: CommittedTree, directory: string, run: ImageContext['run']): Promise<string> {
  const archive = `${directory}.tar`;
  fs.mkdirSync(directory, { recursive: true });
  await run('git', ['archive', '--format=tar', `--output=${archive}`, tree.treeish], tree.repository);
  await run('tar', ['-xf', archive, '-C', directory]);
  const stagedDockerfile = path.join(directory, tree.dockerfilePath);
  if (!fs.existsSync(stagedDockerfile))
    throw new Error(`Container Dockerfile must be committed: ${tree.dockerfilePath}`);
  return stagedDockerfile;
}

async function buildAndPushImage(image: string, source: CommittedImageSource, context: ImageContext): Promise<void> {
  const { temporaryDir, run } = context;
  const directory = path.join(temporaryDir, source.key);
  const stagedDockerfile = await extractCommittedTree(source, directory, run);
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
    ...source.buildVars.flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
    directory,
  ]);
  await run('wrangler', ['containers', 'push', image, ...context.wranglerArgs]);
}
