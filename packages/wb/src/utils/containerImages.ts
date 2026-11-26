import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import chalk from 'chalk';
import { z } from 'zod';

import type { Project } from '../project.js';
import type { ContainerImage, ResolvedCloudflareConfig } from './cloudflareConfig.js';
import { resolveDeployCloudflareConfig } from './cloudflareConfig.js';
import { buildShellCommand } from './shell.js';

export type ContainersRollout = 'none' | 'gradual' | 'immediate';

export const CONTAINER_IMAGE_ENV_PREFIX = 'WB_CONTAINER_IMAGE_';

const PLATFORM = 'linux/amd64';

const registryCredentialsSchema = z.object({
  account_id: z.string(),
  registry_host: z.string(),
  username: z.string(),
  password: z.string(),
});

interface ContainerImageDeployment {
  project: Project;
  envName: string;
  resolvedConfig: ResolvedCloudflareConfig;
  buildEnv: Readonly<Record<string, string | undefined>>;
  authEnv: Readonly<Record<string, string | undefined>>;
  rollout: ContainersRollout | undefined;
  dryRun: boolean | undefined;
}

interface DockerfileImage {
  name: string;
  variableName: string;
  dockerfile: string;
  buildContext?: string;
  buildVars: Record<string, string>;
}

interface CommittedImageSource {
  image: DockerfileImage;
  repository: string;
  treeish: string;
  dockerfilePath: string;
  /** The image's repository and tag in the managed registry, without the account. */
  repositoryName: string;
  tag: string;
}

/**
 * The image references `cloudflare.config.ts` must use in place of its Dockerfile images, keyed on
 * the variable that carries each. For a `gradual`/`immediate` rollout, each is the digest-pinned
 * reference of the image built from the committed build context: published by an earlier deploy,
 * or built and pushed now. Otherwise the deploy keeps the deployed Containers (`none`), so each is
 * a placeholder that the build records but the upload never sends. Either way the build needs no
 * Docker, and wb verifies that the config takes every reference before the build starts.
 */
export async function resolveContainerImageEnv(deployment: ContainerImageDeployment): Promise<Record<string, string>> {
  const images = selectDockerfileImages(deployment.resolvedConfig.containerImages);
  if (images.length === 0) return {};
  const registryHost = deployment.project.env.CLOUDFLARE_CONTAINER_REGISTRY || 'registry.cloudflare.com';
  const env: Record<string, string> = {};
  if (deployment.rollout === 'gradual' || deployment.rollout === 'immediate') {
    // Every context must be clean before the first image is built.
    const sources = images.map((image) => resolveCommittedImageSource(image, deployment));
    for (const source of sources) {
      env[source.image.variableName] = deployment.dryRun
        ? createPlaceholderReference(registryHost, source.image)
        : await publishImage(source, registryHost, deployment);
      if (deployment.dryRun) {
        console.info(
          `Would reuse the published container image ${source.repositoryName}:${source.tag}, or build it from ${source.treeish} and push it.`
        );
      }
    }
  } else {
    console.info(
      `Not building container images (${images.map(({ name }) => name).join(', ')}): the deploy keeps the deployed Containers.`
    );
    for (const image of images) env[image.variableName] = createPlaceholderReference(registryHost, image);
  }
  assertConfigUsesImageReferences(deployment, images, env);
  return env;
}

function selectDockerfileImages(containerImages: ContainerImage[]): DockerfileImage[] {
  const images: DockerfileImage[] = [];
  for (const { name, source } of containerImages) {
    if (!('dockerfile' in source)) continue;
    const variableName = toVariableName(name);
    const collidingImage = images.find((image) => image.variableName === variableName);
    if (collidingImage) {
      throw new Error(`The container images ${collidingImage.name} and ${name} share the variable ${variableName}.`);
    }
    images.push({ name, variableName, ...source, buildVars: source.buildVars ?? {} });
  }
  return images;
}

function toVariableName(imageName: string): string {
  return `${CONTAINER_IMAGE_ENV_PREFIX}${imageName.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, '_')}`;
}

/** A reference in the form cf accepts for every image, which names no published image. */
function createPlaceholderReference(registryHost: string, image: DockerfileImage): string {
  return `${registryHost}/wb-unused/${toRepositoryName(image.name)}@sha256:${'0'.repeat(64)}`;
}

function toRepositoryName(imageName: string): string {
  return `wb/${imageName.toLowerCase().replaceAll(/[^a-z0-9-]/gu, '-')}`;
}

function resolveCommittedImageSource(
  image: DockerfileImage,
  { project, resolvedConfig }: ContainerImageDeployment
): CommittedImageSource {
  const dockerfile = path.resolve(project.dirPath, image.dockerfile);
  const buildContext = path.resolve(project.dirPath, image.buildContext ?? path.dirname(dockerfile));
  const dockerfilePath = path.relative(buildContext, dockerfile);
  if (dockerfilePath.startsWith('..') || path.isAbsolute(dockerfilePath)) {
    throw new Error(`The Dockerfile of the container image ${image.name} must be inside its build context.`);
  }
  const repository = runGit(['rev-parse', '--show-toplevel'], buildContext);
  const contextPath = path.relative(repository, buildContext);
  const revision = runGit(['rev-parse', 'HEAD'], repository);
  if (runGit(['diff', revision, '--', contextPath || '.'], repository)) {
    throw new Error(`Commit the changes to the build context of the container image ${image.name}: ${buildContext}`);
  }
  const treeish = `${revision}:${contextPath}`;
  if (!runGit(['ls-tree', '--name-only', treeish, '--', dockerfilePath], repository)) {
    throw new Error(`Commit the Dockerfile of the container image ${image.name}: ${dockerfile}`);
  }
  const buildVars = Object.entries(image.buildVars).toSorted(([a], [b]) => a.localeCompare(b));
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        tree: runGit(['rev-parse', treeish], repository),
        workerName: resolvedConfig.workerName,
        dockerfilePath,
        buildVars,
        platform: PLATFORM,
      })
    )
    .digest('hex');
  return {
    image,
    repository,
    treeish,
    dockerfilePath,
    repositoryName: toRepositoryName(image.name),
    tag: `source-${key}`,
  };
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

async function publishImage(
  source: CommittedImageSource,
  registryHost: string,
  deployment: ContainerImageDeployment
): Promise<string> {
  const image = `${source.repositoryName}:${source.tag}`;
  const publishedReference = await findPublishedImage(source, registryHost, deployment);
  if (publishedReference) {
    console.info(chalk.cyan(`Reusing the published container image ${image}.`));
    return publishedReference;
  }
  buildAndPushImage(source, deployment);
  const pushedReference = await findPublishedImage(source, registryHost, deployment);
  if (!pushedReference) throw new Error(`The pushed container image ${image} is missing from the registry.`);
  return pushedReference;
}

/** The digest-pinned reference of the published image, or undefined when its tag is not published. */
async function findPublishedImage(
  { repositoryName, tag }: CommittedImageSource,
  registryHost: string,
  { project, envName, authEnv }: ContainerImageDeployment
): Promise<string | undefined> {
  const credentials = registryCredentialsSchema.parse(
    parseJsonObject(
      execFileSync(
        'cf',
        [
          'containers',
          'registries',
          'credentials',
          'generate',
          registryHost,
          '--expiration-minutes',
          '5',
          '--permissions',
          'pull',
          '--mode',
          envName,
        ],
        // The output holds a registry password, so it is never printed.
        {
          cwd: project.dirPath,
          env: authEnv as NodeJS.ProcessEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
        }
      )
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
  if (response.status === 404) return;
  const digest = response.headers.get('Docker-Content-Digest');
  if (!response.ok || !digest) {
    throw new Error(`Failed to look up the container image ${repositoryName}:${tag}: ${response.status}`);
  }
  return `${credentials.registry_host}/${repository}@${digest}`;
}

/** cf evaluates the config for every command, and the config may print to stdout before the result. */
function parseJsonObject(stdout: string): unknown {
  for (const { index } of stdout.matchAll(/\{/gu)) {
    try {
      return JSON.parse(stdout.slice(index));
    } catch {
      // Not the start of the result.
    }
  }
  throw new Error('cf printed no registry credentials.');
}

function buildAndPushImage(
  source: CommittedImageSource,
  { project, envName, authEnv }: ContainerImageDeployment
): void {
  const image = `${source.repositoryName}:${source.tag}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-container-image-'));
  try {
    // Only the committed tree reaches Docker: uncommitted and untracked files stay out of the image.
    const archive = path.join(directory, 'context.tar');
    const contextDir = path.join(directory, 'context');
    fs.mkdirSync(contextDir);
    runGit(['archive', '--format=tar', `--output=${archive}`, source.treeish], source.repository);
    execFileSync('tar', ['-xf', archive, '-C', contextDir]);
    console.info(chalk.cyan(`Building the container image ${image} from ${source.treeish}.`));
    runInheriting(
      'docker',
      [
        'build',
        '--load',
        '--provenance=false',
        '--platform',
        PLATFORM,
        '-f',
        path.join(contextDir, source.dockerfilePath),
        '-t',
        image,
        ...Object.entries(source.image.buildVars).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
        contextDir,
      ],
      project,
      project.env
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  runInheriting('cf', ['containers', 'push', '--tag', image, '--mode', envName], project, authEnv);
}

function runInheriting(
  command: string,
  args: string[],
  project: Project,
  env: Readonly<Record<string, string | undefined>>
): void {
  console.info(chalk.cyan(`Running: ${buildShellCommand([command, ...args])}`));
  const ret = spawnSync(command, args, { cwd: project.dirPath, env: env as NodeJS.ProcessEnv, stdio: 'inherit' });
  if (ret.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed with ${ret.status ?? ret.signal ?? String(ret.error)}.`);
  }
}

/**
 * Running the build with a Dockerfile image left in the config would build it from the working
 * tree, so the config must take every reference wb hands it before the build starts.
 */
function assertConfigUsesImageReferences(
  { project, envName, buildEnv }: ContainerImageDeployment,
  images: DockerfileImage[],
  env: Record<string, string>
): void {
  const containerImages =
    resolveDeployCloudflareConfig(project, envName, { ...buildEnv, ...env })?.containerImages ?? [];
  const ignoredImages = images.filter(({ name, variableName }) => {
    const source = containerImages.find((image) => image.name === name)?.source;
    return !source || !('reference' in source) || source.reference !== env[variableName];
  });
  if (ignoredImages.length > 0) {
    throw new Error(
      `cloudflare.config.ts must declare each container image built from a Dockerfile as \`{ reference: process.env.<variable> }\` while wb sets that variable: ${ignoredImages.map(({ name, variableName }) => `${name} (${variableName})`).join(', ')}.`
    );
  }
}
