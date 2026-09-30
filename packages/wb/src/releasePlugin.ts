/**
 * The semantic-release plugin `@willbooster/wb/release-plugin`, which publishes the crate (the optional `crate`
 * option), the npm package in `pkgRoot`, and the GitHub Release in the `prepare` step, creating the version tag last.
 * It builds the artifacts with `script/build-release <version>` first. `wb release` completes a release that a failed
 * run left pending, so run the release through `wb release`.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  buildScriptPath,
  findOrCreateDraftRelease,
  publishRelease,
  releasePluginConfigSchema,
  runBuildScript,
} from './release/draftRelease.js';
import type { Logger } from './release/draftRelease.js';
import { createGitHubClient } from './release/http.js';

interface Context {
  cwd: string;
  env: Record<string, string | undefined>;
  logger: Logger;
}

export function verifyConditions(pluginConfig: unknown, { cwd, env }: Context): void {
  releasePluginConfigSchema.parse(pluginConfig);
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_TOKEN']) {
    if (!env[name]) throw new Error(`${name} is not set.`);
  }
  fs.accessSync(path.join(cwd, buildScriptPath), fs.constants.X_OK);
}

export async function prepare(
  pluginConfig: unknown,
  {
    cwd,
    env,
    logger,
    nextRelease,
  }: Context & { nextRelease: { gitHead: string; gitTag: string; name: string; notes?: string; version: string } }
): Promise<void> {
  const config = releasePluginConfigSchema.parse(pluginConfig);
  runBuildScript(cwd, env, nextRelease.version);
  const draft = await findOrCreateDraftRelease(createGitHubClient(env), nextRelease);
  await publishRelease({ config, cwd, env, logger, draft, version: nextRelease.version });
}
