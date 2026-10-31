import type { Octokit } from '@octokit/core';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, hasGitHubToken } from '../utils/githubUtil.js';

const priorityLabels: [name: string, color: string][] = [
  ['p1: critical :fire::fire::fire:', 'EF4444'],
  ['p2: urgent :fire::fire:', 'F87171'],
  ['p3: important :fire:', 'FCA5A5'],
  ['p4: nice to have :droplet:', 'FECACA'],
];
// Labels that agent tooling applies itself (e.g., review-booster's retrospect reports), so wbfy keeps
// them where they exist instead of creating them in every repository.
const agentLabelNames = ['retrospect'];

export async function setupLabels(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupLabels', async () => {
    const { repoAuthor: owner, repoName: repo } = config;
    if (!owner || !repo || !config.isWillBoosterRepo) return;
    if (!hasGitHubToken(owner)) return;

    const octokit = getOctokit(owner);

    try {
      for (const [name, color] of priorityLabels) await setupLabel(octokit, owner, repo, name, color);
      const { data: existingLabels } = await octokit.request('GET /repos/{owner}/{repo}/labels', {
        owner,
        repo,
        per_page: 100,
      });
      const keptNames = new Set([...priorityLabels.map(([name]) => name), ...agentLabelNames]);
      for (const { name } of existingLabels) {
        if (!keptNames.has(name)) await deleteLabel(octokit, owner, repo, name);
      }
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
    await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', { owner, repo, name });
  } catch (error) {
    // Another wbfy run or a person may delete the same label between the listing and this request.
    if ((error as { status?: number }).status !== 404) throw error;
  }
}
