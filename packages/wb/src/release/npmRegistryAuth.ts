import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import { z } from 'zod';

import { spawnAsync } from '@willbooster/shared-lib-node/src';

import type { Project } from '../project.js';

/**
 * @semantic-release/npm verifies its token with `npm whoami` only for the official npm registry (where it also supports
 * trusted publishing), so a token another registry rejects (e.g. after a password rotation on a private registry) would
 * fail only the publish, after semantic-release has pushed the version tag. This runs the same check for every other
 * registry that the npm plugin publishes to, before anything is released.
 */
export async function verifyPublishRegistryAuth(
  project: Pick<Project, 'dirPath' | 'env'>,
  npmPluginOptionsList: Record<string, unknown>[]
): Promise<void> {
  for (const options of npmPluginOptionsList) {
    if (options.npmPublish === false) continue;
    const manifest = readPublishedManifest(project, options);
    if (!manifest?.name || manifest.private) continue;
    const registry = manifest.registry ?? (await resolveRegistry(project, manifest.name));
    if (!registry || isOfficialNpmRegistry(registry)) continue;

    console.info(chalk.cyan(`Verifying authentication for ${registry}...`));
    // From the repository root, like the npm plugin, which publishes with the npm configuration found there.
    const { status, stderr } = await spawnAsync('npm', ['whoami', '--registry', registry], {
      cwd: project.dirPath,
      env: project.env,
    });
    if (status !== 0) {
      throw new Error(
        `\`npm whoami --registry ${registry}\` failed, so publishing ${manifest.name} would be rejected. Nothing has been released; configure a token that ${registry} accepts and re-run.\n${stderr.trim()}`
      );
    }
  }
}

/** Mirrors @semantic-release/npm's lookup for a package without `publishConfig.registry`. */
async function resolveRegistry(
  project: Pick<Project, 'dirPath' | 'env'>,
  packageName: string
): Promise<string | undefined> {
  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : undefined;
  for (const key of scope ? [`${scope}:registry`, 'registry'] : ['registry']) {
    const { status, stdout } = await spawnAsync('npm', ['config', 'get', key], {
      cwd: project.dirPath,
      env: project.env,
    });
    const value = stdout.trim();
    if (status === 0 && value && value !== 'undefined') return value;
  }
}

function isOfficialNpmRegistry(registry: string): boolean {
  try {
    return new URL(registry).host === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

const publishedManifestSchema = z.object({
  name: z.string().optional(),
  private: z.boolean().optional(),
  publishConfig: z.object({ registry: z.string().optional() }).optional(),
});

/** Reads the manifest that @semantic-release/npm publishes with `options`, or `undefined` when it cannot be read. */
export function readPublishedManifest(
  project: Pick<Project, 'dirPath'>,
  options: Record<string, unknown>
): { name?: string; private?: boolean; registry?: string } | undefined {
  const parsedOptions = z.object({ pkgRoot: z.string().optional() }).safeParse(options).data;
  if (!parsedOptions) return;
  try {
    const manifest = publishedManifestSchema.safeParse(
      JSON.parse(fs.readFileSync(path.resolve(project.dirPath, parsedOptions.pkgRoot ?? '.', 'package.json'), 'utf8'))
    ).data;
    return manifest && { name: manifest.name, private: manifest.private, registry: manifest.publishConfig?.registry };
  } catch {
    return;
  }
}
