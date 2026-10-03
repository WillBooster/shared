import { Octokit } from '@octokit/core';

import { spawnOrUndefined } from './spawnUtil.js';

class GitHubUtil {
  getOrgAndName(urlOrFullName: string): [string, string] {
    const urlWithoutProtocol = urlOrFullName.split(':').at(-1);
    const names = urlWithoutProtocol?.split('/');
    const org = names?.at(-2) ?? '';
    // The dot must be escaped: an unescaped `.` matches ANY character, so `legit` lost its `l` and `e`.
    const name = names?.at(-1)?.replace(/\.git$/u, '') ?? '';
    return [org, name];
  }
}
export const gitHubUtil = new GitHubUtil();

export function isGitHubPermissionOrVisibilityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: number }).status;
  return status === 401 || status === 403 || status === 404;
}

const octokitCache = new Map<string, Octokit>();

export async function getOctokit(owner?: string): Promise<Octokit> {
  // GitHub owner names are case-insensitive, so credential selection (and the cache key) must
  // not depend on how a remote URL happens to spell the organization.
  const key = owner?.toLowerCase() ?? '';
  const cached = octokitCache.get(key);
  if (cached) return cached;

  const octokit = new Octokit({
    auth: (await getGitHubToken(owner)) || undefined,
  });
  octokitCache.set(key, octokit);
  return octokit;
}

export async function hasGitHubToken(owner: string): Promise<boolean> {
  return !!(await getGitHubToken(owner));
}

async function getGitHubToken(owner?: string): Promise<string | undefined> {
  // Case-insensitive on purpose: a noncanonically cased remote (e.g. github.com/willboosterlab/…)
  // must still select the organization's own PAT — falling through to the generic branch would
  // prefer the OTHER organization's PAT, which cannot read this organization's private
  // repositories.
  const normalizedOwner = owner?.toLowerCase();
  if (normalizedOwner === 'willbooster') {
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTER || (await getGitHubCliToken());
  }
  if (normalizedOwner === 'willboosterlab') {
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB || (await getGitHubCliToken());
  }
  return (
    process.env.GH_BOT_PAT_FOR_WILLBOOSTER ||
    process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    (await getGitHubCliToken())
  );
}

let gitHubCliToken: Promise<string | undefined> | undefined;

function getGitHubCliToken(): Promise<string | undefined> {
  gitHubCliToken ??= readGitHubCliToken();
  return gitHubCliToken;
}

async function readGitHubCliToken(): Promise<string | undefined> {
  // Some local runs rely on GitHub CLI authentication instead of exported env tokens.
  const result = await spawnOrUndefined('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return (result?.status === 0 && result.stdout.trim()) || undefined;
}
