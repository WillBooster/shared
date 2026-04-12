import { Octokit } from '@octokit/core';

class GitHubUtil {
  getOrgAndName(urlOrFullName: string): [string, string] {
    const urlWithoutProtocol = urlOrFullName.split(':').at(-1);
    const names = urlWithoutProtocol?.split('/');
    const org = names?.at(-2) ?? '';
    const name = names?.at(-1)?.replace(/.git$/, '') ?? '';
    return [org, name];
  }
}
export const gitHubUtil = new GitHubUtil();

const octokitCache = new Map<string, Octokit>();

export function getOctokit(owner?: string): Octokit {
  const key = owner ?? '';
  const cached = octokitCache.get(key);
  if (cached) return cached;

  const octokit = new Octokit({
    auth: getGitHubToken(owner) || undefined,
  });
  octokitCache.set(key, octokit);
  return octokit;
}

export function hasGitHubToken(owner: string): boolean {
  return !!getGitHubToken(owner);
}

function getGitHubToken(owner?: string): string | undefined {
  if (owner === 'WillBooster') {
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTER;
  }
  if (owner === 'WillBoosterLab') {
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB;
  }
  return (
    process.env.GH_BOT_PAT_FOR_WILLBOOSTER ||
    process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN
  );
}
