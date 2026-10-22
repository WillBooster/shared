import { Octokit } from '@octokit/core';

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

export function getOctokit(owner?: string): Octokit {
  // GitHub owner names are case-insensitive, so credential selection (and the cache key) must
  // not depend on how a remote URL happens to spell the organization.
  const key = owner?.toLowerCase() ?? '';
  const cached = octokitCache.get(key);
  if (cached) return cached;

  const octokit = new Octokit({
    auth: getGitHubToken(owner) || undefined,
  });
  octokitCache.set(key, octokit);
  return octokit;
}

let anonymousOctokit: Octokit | undefined;

/** A client that sends no credential, for reading what GitHub shows to anyone (e.g. a public repository). */
export function getAnonymousOctokit(): Octokit {
  anonymousOctokit ??= new Octokit();
  return anonymousOctokit;
}

export function hasGitHubToken(owner: string): boolean {
  return !!getGitHubToken(owner);
}

function getGitHubToken(owner?: string): string | undefined {
  // Read only the environment, never a CLI session (`gh auth token`): the caller exports the token,
  // which keeps credential lookups out of this published package.
  // Case-insensitive on purpose: a noncanonically cased remote (e.g. github.com/willboosterlab/…)
  // must still select the organization's own PAT instead of the generic GH_TOKEN / GITHUB_TOKEN
  // that any other owner gets.
  const normalizedOwner = owner?.toLowerCase();
  if (normalizedOwner === 'willbooster') {
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTER || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  }
  if (normalizedOwner === 'willboosterlab') {
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  }
  if (owner === undefined) {
    return (
      process.env.GH_BOT_PAT_FOR_WILLBOOSTER ||
      process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB ||
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN
    );
  }
  // An organization PAT has no write access to another owner's repository (e.g. for labels).
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
}
