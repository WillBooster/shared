import type { Octokit } from '@octokit/core';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';

export async function setupLabels(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupLabels', async () => {
    const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
    if (!owner || !repo) return;
    if (owner !== 'WillBooster' && owner !== 'WillBoosterLab') return;
    if (!hasGitHubToken(owner)) return;

    const octokit = getOctokit(owner);

    try {
      await setupLabel(octokit, owner, repo, 'd1: x-easy :hedgehog:', 'EDE9FE');
      await setupLabel(octokit, owner, repo, 'd2: easy :rabbit2:', 'DDD6FE');
      await setupLabel(octokit, owner, repo, 'd3: medium :ox:', 'C4B5FD');
      await setupLabel(octokit, owner, repo, 'd4: hard :squid:', 'A78BFA');
      await setupLabel(octokit, owner, repo, 'd5: x-hard :whale2:', '8B5CF6');
      await setupLabel(octokit, owner, repo, 'p1: critical :fire::fire::fire:', 'EF4444');
      await setupLabel(octokit, owner, repo, 'p2: urgent :fire::fire:', 'F87171');
      await setupLabel(octokit, owner, repo, 'p3: important :fire:', 'FCA5A5');
      await setupLabel(octokit, owner, repo, 'p4: nice to have :droplet:', 'FECACA');
      await setupLabel(octokit, owner, repo, 'r: blitz', '5300bc');
      await setupLabel(octokit, owner, repo, 'r: firebase', 'ffca28');
      await setupLabel(octokit, owner, repo, 'r: prisma', '0c344b');
      await setupLabel(octokit, owner, repo, 'r: react', '61dafb');
      await setupLabel(octokit, owner, repo, 'r: svelte', 'ff3e00');
      await setupLabel(octokit, owner, repo, 'r: semantic-release', '494949');
      await setupLabel(octokit, owner, repo, 'ready :rocket:', '22C55E');
      await setupLabel(octokit, owner, repo, 'review requested :mag:', 'FBCA04');
      await setupLabel(octokit, owner, repo, 'released :bookmark:', '6366F1');
      await setupLabel(octokit, owner, repo, 's: 0.5h :clock1230:', 'F3F4F6');
      await setupLabel(octokit, owner, repo, 's: 1h :clock1:', 'E5E7EB');
      await setupLabel(octokit, owner, repo, 's: 2h :clock2:', 'D1D5DB');
      await setupLabel(octokit, owner, repo, 's: 3h :clock3:', '9CA3AF');
      await setupLabel(octokit, owner, repo, 's: 5h :clock5:', '6B7280');
      await setupLabel(octokit, owner, repo, 's: 8h :clock8:', '4B5563');
      await setupLabel(octokit, owner, repo, 's: 13h :clock1:', '374151');
      await setupLabel(octokit, owner, repo, 't: build :hammer:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: chore :broom:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: ci :construction_worker:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: docs :memo:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: feat :sparkles:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: fix :bug:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: perf :zap:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: refactor :recycle:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: style :lipstick:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 't: test :test_tube:', 'BFDBFE');
      await setupLabel(octokit, owner, repo, 'project', '24292F');
      await setupLabel(octokit, owner, repo, 'focused :dart:', '22C55E');
      await setupLabel(octokit, owner, repo, 'gen-pr-all :robot:', '00B4D8');
      await setupLabel(octokit, owner, repo, 'gen-pr-claude :robot:', '00B4D8');
      await setupLabel(octokit, owner, repo, 'gen-pr-codex :robot:', '00B4D8');
      await setupLabel(octokit, owner, repo, 'gen-pr-gemini :robot:', '00B4D8');

      await deleteLabel(octokit, owner, repo, 'bug');
      await deleteLabel(octokit, owner, repo, 'documentation');
      await deleteLabel(octokit, owner, repo, 'duplicate');
      await deleteLabel(octokit, owner, repo, 'enhancement');
      await deleteLabel(octokit, owner, repo, 'good first issue');
      await deleteLabel(octokit, owner, repo, 'help wanted');
      await deleteLabel(octokit, owner, repo, 'invalid');
      await deleteLabel(octokit, owner, repo, 'question');
      await deleteLabel(octokit, owner, repo, 'wontfix');

      await deleteLabel(octokit, owner, repo, 'ready');
      await deleteLabel(octokit, owner, repo, 'review requested');
      await deleteLabel(octokit, owner, repo, 'released');
      await deleteLabel(octokit, owner, repo, 'semantic-release');
      await deleteLabel(octokit, owner, repo, 'llm-pr :robot:');
      await deleteLabel(octokit, owner, repo, 'ai-pr :robot:');
    } catch (error) {
      console.warn('Skip setupLabels due to:', (error as Error | undefined)?.stack ?? error);
    }
  });
}

async function setupLabel(octokit: Octokit, owner: string, repo: string, name: string, color: string): Promise<void> {
  try {
    // Issues permission
    await octokit.request('POST /repos/{owner}/{repo}/labels', {
      owner,
      repo,
      name,
      color,
    });
  } catch {
    // Issues permission
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
    // Issues permission
    await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
      owner,
      repo,
      name,
    });
  } catch {
    // do nothing
  }
}
