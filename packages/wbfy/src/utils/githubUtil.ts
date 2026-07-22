import childProcess from 'node:child_process';

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
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTER || getGitHubCliToken();
  }
  if (owner === 'WillBoosterLab') {
    return process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB || getGitHubCliToken();
  }
  return (
    process.env.GH_BOT_PAT_FOR_WILLBOOSTER ||
    process.env.GH_BOT_PAT_FOR_WILLBOOSTERLAB ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    getGitHubCliToken()
  );
}

let gitHubCliToken: string | undefined;

function getGitHubCliToken(): string | undefined {
  if (gitHubCliToken !== undefined) return gitHubCliToken || undefined;

  try {
    // Some local runs rely on GitHub CLI authentication instead of exported env tokens.
    gitHubCliToken =
      childProcess
        .execFileSync('gh', ['auth', 'token'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .trim() || '';
  } catch {
    gitHubCliToken = '';
  }
  return gitHubCliToken || undefined;
}
