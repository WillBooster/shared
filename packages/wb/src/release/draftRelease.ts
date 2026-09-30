// The draft-first release: every registry receives the version before the version tag exists. semantic-release pushes
// the tag between `prepare` and `publish`, so a failure in `publish` would leave the tag behind, and a re-run would
// find no new commits and never complete the release. Here the tag is created last, by publishing a draft GitHub
// Release that records the version, the commit, and the notes before any registry receives the version. A re-run of a
// failed release computes the same version and skips each registry that already holds it from the same commit;
// `wb release` completes a release left pending when a newer commit reaches the branch (see pendingRelease.ts).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { createGitHubClient, fetchWithRetry, userAgent } from './http.js';
import type { GitHubClient } from './http.js';

export const releasePluginName = '@willbooster/wb/release-plugin';
// Writes the release version given as its argument and builds every artifact the release publishes.
export const buildScriptPath = path.join('script', 'build-release');
// Marks the drafts this release flow creates, so that it never completes or deletes a draft someone else prepared.
const pendingMarker = '\n\n<!-- pending release -->';

export const releasePluginConfigSchema = z.object({
  // Omitted for a repository that publishes only the npm package.
  crate: z.string().min(1).optional(),
  pkgRoot: z.string().min(1),
});
export type ReleasePluginConfig = z.infer<typeof releasePluginConfigSchema>;

const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  target_commitish: z.string(),
  draft: z.boolean(),
  body: z.string().nullable(),
  html_url: z.string(),
});
export type Release = z.infer<typeof releaseSchema>;

export interface Logger {
  log: (message: string) => void;
}

type Env = Record<string, string | undefined>;

export function runBuildScript(cwd: string, env: Env, version: string): void {
  execFileSync(path.join(cwd, buildScriptPath), [version], { cwd, env, stdio: 'inherit' });
}

/** Returns the draft release of `gitTag` that this release flow created, creating it if absent. */
export async function findOrCreateDraftRelease(
  github: GitHubClient,
  { gitHead, gitTag, name, notes }: { gitHead: string; gitTag: string; name: string; notes?: string }
): Promise<Release> {
  const draft =
    (await findDraftRelease(github, gitTag)) ??
    releaseSchema.parse(
      await github(
        'POST',
        'releases',
        { tag_name: gitTag, target_commitish: gitHead, name, body: `${notes ?? ''}${pendingMarker}`, draft: true },
        () => findDraftRelease(github, gitTag)
      )
    );
  if (draft.target_commitish !== gitHead) {
    throw new Error(`The draft release ${gitTag} targets ${draft.target_commitish}, not ${gitHead}.`);
  }
  return draft;
}

/** Publishes the version to every registry that does not hold it yet, and then publishes the draft release. */
export async function publishRelease({
  config: { crate, pkgRoot },
  cwd,
  env,
  logger,
  draft,
  version,
}: {
  config: ReleasePluginConfig;
  cwd: string;
  env: Env;
  logger: Logger;
  draft: Release;
  version: string;
}): Promise<void> {
  const gitHead = draft.target_commitish;
  const pkgDir = path.resolve(cwd, pkgRoot);
  const run = (command: string, args: string[], dir: string): void => {
    execFileSync(command, args, { cwd: dir, env, stdio: 'inherit' });
  };
  const publishedCommits = await fetchPublishedCommits({ crate, cwd, pkgRoot, version });
  const targets = publishedCommits.map((target) => ({
    ...target,
    ...(target.registry === 'crates.io' && crate
      ? {
          dryRun: async () => run('cargo', ['publish', '--dry-run', '--allow-dirty', '-p', crate], cwd),
          publish: () => publishCrate(crate, cwd, env),
        }
      : {
          dryRun: async () => run('npm', ['publish', '--dry-run'], pkgDir),
          publish: async () => run('npm', ['publish'], pkgDir),
        }),
  }));
  for (const { commit, name } of targets) {
    if (commit !== undefined && commit !== gitHead) {
      throw new Error(`${name} was published from ${commit || 'an unknown commit'}, not from ${gitHead}.`);
    }
  }

  const unpublished = targets.filter(({ commit }) => commit === undefined);
  // Dry runs catch packaging errors before any registry receives the version.
  for (const target of unpublished) await target.dryRun();
  for (const target of targets) {
    if (unpublished.includes(target)) await target.publish();
    else logger.log(`Skipped ${target.name}, which is already published from ${gitHead}`);
  }

  // Publishing the draft creates the tag, so semantic-release's tag push that follows changes nothing.
  const release = releaseSchema.parse(
    await createGitHubClient(env)('PATCH', `releases/${draft.id}`, {
      draft: false,
      body: draft.body?.slice(0, -pendingMarker.length),
    })
  );
  logger.log(`Published the GitHub Release ${release.html_url}`);
}

/**
 * Returns the commit each registry published the version from: `undefined` for an unpublished version, and an empty
 * string when the registry records no commit.
 */
export async function fetchPublishedCommits({
  crate,
  cwd,
  pkgRoot,
  version,
}: ReleasePluginConfig & { cwd: string; version: string }): Promise<
  { registry: 'crates.io' | 'npm'; name: string; commit: string | undefined }[]
> {
  const { name: pkgName } = z
    .object({ name: z.string() })
    .parse(JSON.parse(fs.readFileSync(path.resolve(cwd, pkgRoot, 'package.json'), 'utf8')));
  return [
    ...(crate
      ? [
          {
            registry: 'crates.io' as const,
            name: `${crate}@${version} on crates.io`,
            commit: await fetchPublishedCommit(
              `https://crates.io/api/v1/crates/${crate}/${version}`,
              (body) =>
                z.object({ version: z.object({ trustpub_data: z.object({ sha: z.string() }).nullish() }) }).parse(body)
                  .version.trustpub_data?.sha
            ),
          },
        ]
      : []),
    {
      registry: 'npm' as const,
      name: `${pkgName}@${version} on npm`,
      commit: await fetchPublishedCommit(
        `https://registry.npmjs.org/${pkgName.replace('/', '%2f')}/${version}`,
        (body) => z.object({ gitHead: z.string().optional() }).parse(body).gitHead
      ),
    },
  ];
}

async function fetchPublishedCommit(
  url: string,
  getCommit: (body: unknown) => string | undefined
): Promise<string | undefined> {
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': userAgent } });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  return getCommit(await response.json()) ?? '';
}

/**
 * Publishes the crate with crates.io's trusted publishing, exchanging the GitHub Actions OIDC token for a short-lived
 * crates.io token. crates.io matches the caller's `release.yml` workflow, not the reusable workflow it calls.
 */
async function publishCrate(crate: string, cwd: string, env: Env): Promise<void> {
  const { value: jwt } = z.object({ value: z.string() }).parse(
    await fetchJson(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=crates.io`, {
      headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    })
  );
  const tokensUrl = 'https://crates.io/api/v1/trusted_publishing/tokens';
  const { token } = z.object({ token: z.string() }).parse(
    await fetchJson(
      tokensUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
        body: JSON.stringify({ jwt }),
      },
      // Another token for the same OIDC token is as good, and both expire on their own.
      true
    )
  );
  try {
    // The release versions that script/build-release writes are not committed.
    execFileSync('cargo', ['publish', '-p', crate, '--allow-dirty'], {
      cwd,
      env: { ...env, CARGO_REGISTRY_TOKEN: token },
      stdio: 'inherit',
    });
  } finally {
    // Revocation is best-effort (the token expires on its own); its failure must not fail an already-done publish.
    const response = await fetchWithRetry(tokensUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
    }).catch((error: unknown) => error);
    if (!(response instanceof Response) || !response.ok) console.warn('Failed to revoke the crates.io token.');
  }
}

async function fetchJson(url: string, init: RequestInit, repeatable = false): Promise<unknown> {
  const response = await fetchWithRetry(url, init, { repeatable });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} failed: ${response.status}`);
  return response.json();
}

/** Returns the draft releases that this release flow created, which GitHub lists before the published releases. */
export async function listPendingReleases(github: GitHubClient): Promise<Release[]> {
  const releases = z.array(releaseSchema).parse(await github('GET', 'releases?per_page=100'));
  return releases.filter((release) => release.draft && release.body?.endsWith(pendingMarker));
}

export async function findDraftRelease(github: GitHubClient, gitTag: string): Promise<Release | undefined> {
  const drafts = await listPendingReleases(github);
  return drafts.find((release) => release.tag_name === gitTag);
}
