import type { Octokit } from '@octokit/core';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, hasGitHubToken } from '../utils/githubUtil.js';

// The issue templates and the AGENTS.md issue rule name these labels in every repository.
const typeLabels: [name: string, color: string][] = [
  ['t: build :hammer:', 'BFDBFE'],
  ['t: chore :broom:', 'BFDBFE'],
  ['t: ci :construction_worker:', 'BFDBFE'],
  ['t: docs :memo:', 'BFDBFE'],
  ['t: feat :sparkles:', 'BFDBFE'],
  ['t: fix :bug:', 'BFDBFE'],
  ['t: perf :zap:', 'BFDBFE'],
  ['t: refactor :recycle:', 'BFDBFE'],
  ['t: style :lipstick:', 'BFDBFE'],
  ['t: test :test_tube:', 'BFDBFE'],
];
const organizationLabels: [name: string, color: string][] = [
  ['d1: x-easy :hedgehog:', 'EDE9FE'],
  ['d2: easy :rabbit2:', 'DDD6FE'],
  ['d3: medium :ox:', 'C4B5FD'],
  ['d4: hard :squid:', 'A78BFA'],
  ['d5: x-hard :whale2:', '8B5CF6'],
  ['p1: critical :fire::fire::fire:', 'EF4444'],
  ['p2: urgent :fire::fire:', 'F87171'],
  ['p3: important :fire:', 'FCA5A5'],
  ['p4: nice to have :droplet:', 'FECACA'],
  ['r: blitz', '5300bc'],
  ['r: firebase', 'ffca28'],
  ['r: prisma', '0c344b'],
  ['r: react', '61dafb'],
  ['r: semantic-release', '494949'],
  ['ready :rocket:', '22C55E'],
  ['review requested :mag:', 'FBCA04'],
  ['released :bookmark:', '6366F1'],
  ['s: 0.5h :clock1230:', 'F3F4F6'],
  ['s: 1h :clock1:', 'E5E7EB'],
  ['s: 2h :clock2:', 'D1D5DB'],
  ['s: 3h :clock3:', '9CA3AF'],
  ['s: 5h :clock5:', '6B7280'],
  ['s: 8h :clock8:', '4B5563'],
  ['s: 13h :clock1:', '374151'],
  ['project', '24292F'],
  ['focused :dart:', '22C55E'],
];
const gitHubDefaultLabels = [
  'bug',
  'documentation',
  'duplicate',
  'enhancement',
  'good first issue',
  'help wanted',
  'invalid',
  'question',
  'wontfix',
];

export async function setupLabels(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupLabels', async () => {
    const { repoAuthor: owner, repoName: repo } = config;
    if (!owner || !repo) return;
    if (!hasGitHubToken(owner)) return;

    const octokit = getOctokit(owner);

    try {
      for (const [name, color] of typeLabels) await setupLabel(octokit, owner, repo, name, color);
      if (owner !== 'WillBooster' && owner !== 'WillBoosterLab') return;

      for (const [name, color] of organizationLabels) await setupLabel(octokit, owner, repo, name, color);
      for (const name of gitHubDefaultLabels) await deleteLabel(octokit, owner, repo, name);
    } catch (error) {
      console.warn('Skip setupLabels due to:', (error as Error | undefined)?.stack ?? error);
    }
  });
}

async function setupLabel(octokit: Octokit, owner: string, repo: string, name: string, color: string): Promise<void> {
  try {
    await octokit.request('POST /repos/{owner}/{repo}/labels', {
      owner,
      repo,
      name,
      color,
    });
  } catch {
    await octokit.request('PATCH /repos/{owner}/{repo}/labels/{name}', {
      owner,
      repo,
      name,
      color,
    });
  }
}

async function deleteLabel(octokit: Octokit, owner: string, repo: string, name: string): Promise<void> {
  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
      owner,
      repo,
      name,
    });
  } catch {
    // do nothing
  }
}
